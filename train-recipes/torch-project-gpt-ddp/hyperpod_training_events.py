"""HyperPod training events for Goodput (HyperPod Training Operator + HyperPod Observability).

Sends the training-side events that the HyperPod Observability add-on's Training Metrics
Agent pairs into ``training_*`` metrics (batch, checkpoint and evaluation time; fault
detection, restart and reprocessing time for Goodput). HPTO itself already reports the job
lifecycle (JOB_CREATE, FAULT_START, ...); these events mark what only the training code
knows: when the training loop starts and stops, when each optimizer step finishes, and
when checkpoints and evaluations run.

Events go out as OpenTelemetry (OTLP/HTTP) log records, once per job from global rank 0:

    body        event name, e.g. BATCH_END
    job_name    HPTO job name (JOB_NAME, injected by HPTO)
    span_id     pairs a *_START with its *_END
    trace_id    one id per training process start
    global_step optimizer step count

Best effort: when OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or JOB_NAME is not set, the endpoint
host does not resolve (add-on not installed), or the OpenTelemetry packages are missing,
events are disabled with one warning and training continues unchanged.

Usage with the Hugging Face Trainer::

    events = TrainingEvents.create()
    trainer = Trainer(..., callbacks=[HyperPodEventsCallback(events)])
    trainer.train()
    with checkpoint_events(events, trainer.state.global_step):
        trainer.save_model(...)
    if events:
        events.close()
"""

from contextlib import contextmanager
import logging
import os
import socket
import time
from urllib.parse import urlparse
import uuid

from transformers import TrainerCallback

logger = logging.getLogger(__name__)

ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
SERVICE_NAME = "instantstart-torch-recipe"


def _new_span_id():
    return uuid.uuid4().hex[:16]


class TrainingEvents:
    """Rank-0 OTLP event sender. Build it with ``TrainingEvents.create()``."""

    @classmethod
    def create(cls):
        """Return a sender on global rank 0 when events can be delivered, otherwise None."""
        if int(os.environ.get("RANK", "0")) != 0:
            return None
        endpoint = os.environ.get(ENDPOINT_ENV, "").strip()
        job_name = os.environ.get("JOB_NAME", "").strip()
        if not endpoint or not job_name:
            logger.warning("[hyperpod-events] disabled: %s and JOB_NAME must both be set", ENDPOINT_ENV)
            return None
        parsed = urlparse(endpoint)
        try:
            socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        except (OSError, UnicodeError) as error:
            logger.warning(
                "[hyperpod-events] disabled: cannot resolve %s (%s); is the HyperPod Observability add-on installed?",
                parsed.hostname, error,
            )
            return None
        try:
            return cls(endpoint, job_name)
        except ImportError as error:
            logger.warning("[hyperpod-events] disabled: OpenTelemetry packages are not installed (%s)", error)
            return None

    def __init__(self, endpoint, job_name):
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.sdk._logs import LoggerProvider
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.resources import Resource

        self.job_name = job_name
        self.run_id = uuid.uuid4().hex
        self.closed = False
        self.provider = LoggerProvider(resource=Resource.create({"service.name": SERVICE_NAME}))
        self.provider.add_log_record_processor(
            BatchLogRecordProcessor(
                OTLPLogExporter(endpoint=endpoint, timeout=10),
                schedule_delay_millis=1000,
                max_export_batch_size=128,
            )
        )
        self.logger = self.provider.get_logger("hyperpod-training-events")
        logger.info("[hyperpod-events] enabled: job=%s endpoint=%s", job_name, endpoint)

    def emit(self, event, span_id, global_step, timestamp_ns=None):
        """Send one event. Never raises: telemetry must not stop training."""
        if self.closed:
            return
        try:
            self.logger.emit(
                body=event,
                timestamp=timestamp_ns if timestamp_ns is not None else time.time_ns(),
                attributes={
                    "job_name": self.job_name,
                    "trace_id": self.run_id,
                    "span_id": span_id,
                    "global_step": int(global_step),
                },
            )
        except Exception as error:  # noqa: BLE001
            logger.warning("[hyperpod-events] failed to emit %s: %s", event, error)

    def start(self, event, global_step, timestamp_ns=None):
        span_id = _new_span_id()
        self.emit(event, span_id, global_step, timestamp_ns)
        return span_id

    def checkpoint(self, global_step, started_ns, finished_ns=None):
        """Record one synchronous checkpoint that ran from started_ns to finished_ns."""
        finished_ns = finished_ns if finished_ns is not None else time.time_ns()
        span_id = self.start("CHECKPOINT_START", global_step, started_ns)
        self.emit("CHECKPOINT_SYNC_END", span_id, global_step, finished_ns)
        # A synchronous save has no async phase. The ASYNC_END goes 1 ms after SYNC_END:
        # the Training Metrics Agent orders events by millisecond timestamp, and two end
        # events in the same millisecond can come back reversed and be paired wrongly.
        self.emit("CHECKPOINT_ASYNC_END", span_id, global_step, finished_ns + 1_000_000)

    def close(self, flush_timeout_ms=30_000):
        if self.closed:
            return
        self.closed = True
        try:
            flushed = self.provider.force_flush(timeout_millis=flush_timeout_ms)
            self.provider.shutdown()
            if not flushed:
                logger.warning("[hyperpod-events] not all events were flushed within %d ms", flush_timeout_ms)
        except Exception as error:  # noqa: BLE001
            logger.warning("[hyperpod-events] close failed: %s", error)


@contextmanager
def checkpoint_events(events, global_step):
    """Wrap a save that runs outside the Trainer loop (e.g. the final save_model)."""
    started_ns = time.time_ns()
    yield
    if events:
        events.checkpoint(global_step, started_ns)


class HyperPodEventsCallback(TrainerCallback):
    """Maps Hugging Face Trainer callbacks to HyperPod training events.

    - TRAINING_START / TRAINING_END: on_train_begin / on_train_end
    - BATCH_START / BATCH_END: one optimizer step (all gradient-accumulation micro-batches)
    - VALIDATION_* and CHECKPOINT_*: the Trainer only calls back *after* evaluate / save,
      so the start time is the last boundary seen before them (end of the step, or the end
      of logging when the step also logs). The events carry explicit timestamps.

    All ranks get the callback; only the rank that owns ``events`` (global rank 0) sends.
    """

    def __init__(self, events):
        self.events = events
        self._training_span = None
        self._batch_span = None
        self._boundary_ns = None

    def on_train_begin(self, args, state, control, **kwargs):
        if self.events:
            self._training_span = self.events.start("TRAINING_START", state.global_step)

    def on_step_begin(self, args, state, control, **kwargs):
        if self.events:
            self._boundary_ns = None
            self._batch_span = self.events.start("BATCH_START", state.global_step + 1)

    def on_step_end(self, args, state, control, **kwargs):
        if not self.events or self._batch_span is None:
            return
        # The step's CUDA kernels may still be queued; wait so BATCH_END marks a finished step.
        import torch
        if torch.cuda.is_available() and torch.cuda.is_initialized():
            torch.cuda.synchronize()
        self.events.emit("BATCH_END", self._batch_span, state.global_step)
        self._batch_span = None
        self._boundary_ns = time.time_ns()

    def on_log(self, args, state, control, logs=None, **kwargs):
        if self.events and self._boundary_ns is not None:
            self._boundary_ns = time.time_ns()

    def on_evaluate(self, args, state, control, metrics=None, **kwargs):
        if not self.events or self._boundary_ns is None:
            return  # evaluate() called outside the training loop
        span_id = self.events.start("VALIDATION_START", state.global_step, self._boundary_ns)
        self.events.emit("VALIDATION_END", span_id, state.global_step)
        self._boundary_ns = time.time_ns()

    def on_save(self, args, state, control, **kwargs):
        if not self.events or self._boundary_ns is None:
            return
        finished_ns = time.time_ns()
        self.events.checkpoint(state.global_step, self._boundary_ns, finished_ns)
        self._boundary_ns = finished_ns

    def on_train_end(self, args, state, control, **kwargs):
        if self.events and self._training_span is not None:
            self.events.emit("TRAINING_END", self._training_span, state.global_step)
            self._training_span = None
        self._boundary_ns = None
