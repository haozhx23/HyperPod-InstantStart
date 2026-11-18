#!/usr/bin/env python3
"""
使用Hugging Face Trainer进行DDP分布式训练
使用argparse解析所有参数
"""

import os
import torch
import argparse
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
    Trainer,
    DataCollatorForLanguageModeling,
    set_seed
)
import logging

# HyperPod Goodput 训练事件（rank 0 通过 OTLP 发送；未配置或不可达时自动关闭，不影响训练）
from hyperpod_training_events import TrainingEvents, HyperPodEventsCallback, checkpoint_events

# 设置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser()
    
    # 模型和数据集参数
    parser.add_argument("--model_name_or_path", type=str, default="gpt2")
    parser.add_argument("--dataset_name", type=str, default="wikitext")
    parser.add_argument("--dataset_config_name", type=str, default="wikitext-2-raw-v1")
    parser.add_argument("--max_context_width", type=int, default=2048)
    parser.add_argument("--train_samples", type=int, default=1000)
    
    # 训练参数
    parser.add_argument("--output_dir", type=str, default="./results")
    parser.add_argument("--overwrite_output_dir", action="store_true", default=True)
    parser.add_argument("--num_train_epochs", type=int, default=3)
    parser.add_argument("--max_steps", type=int, default=-1)
    parser.add_argument("--per_device_train_batch_size", type=int, default=4)
    parser.add_argument("--gradient_accumulation_steps", type=int, default=2)
    parser.add_argument("--learning_rate", type=float, default=5e-5)
    parser.add_argument("--save_steps", type=int, default=100)
    parser.add_argument("--save_strategy", type=str, default="steps", choices=["no", "epoch", "steps"])
    parser.add_argument("--save_total_limit", type=int, default=2)
    parser.add_argument("--dataloader_num_workers", type=int, default=2)
    parser.add_argument("--run_name", type=str, default="gpt2_wikitext_ddp_training")
    parser.add_argument("--report_to", type=str, default="mlflow")
    
    return parser.parse_args()

def preprocess_function(examples, tokenizer, max_context_width):
    """预处理数据集"""
    return tokenizer(
        examples["text"],
        truncation=True,
        padding=True,
        max_length=max_context_width,
        return_tensors="pt"
    )

def main():
    # 解析参数
    args = parse_args()
    
    # 设置随机种子
    set_seed(42)
    
    # 获取分布式训练环境变量
    local_rank = int(os.environ.get("LOCAL_RANK", -1))
    world_size = int(os.environ.get("WORLD_SIZE", 1))
    
    logger.info(f"Local rank: {local_rank}, World size: {world_size}")
    logger.info(f"使用模型: {args.model_name_or_path}")
    logger.info(f"使用数据集: {args.dataset_name}/{args.dataset_config_name}")
    
    # 加载模型和分词器
    tokenizer = AutoTokenizer.from_pretrained(args.model_name_or_path)
    model = AutoModelForCausalLM.from_pretrained(args.model_name_or_path)
    
    # 设置pad token
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.pad_token_id
    
    # 加载数据集
    logger.info("加载数据集...")
    dataset = load_dataset(args.dataset_name, args.dataset_config_name)
    
    # 过滤空文本
    dataset = dataset.filter(lambda example: len(example["text"].strip()) > 0)
    
    # 预处理数据集
    def tokenize_function(examples):
        return preprocess_function(examples, tokenizer, args.max_context_width)
    
    tokenized_dataset = dataset.map(
        tokenize_function,
        batched=True,
        remove_columns=dataset["train"].column_names,
    )
    
    # 选择指定数量的样本
    train_dataset = tokenized_dataset["train"].select(range(min(args.train_samples, len(tokenized_dataset["train"]))))
    
    logger.info(f"训练样本数: {len(train_dataset)}")
    
    # 数据整理器
    data_collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,
    )
    
    # TrainingArguments配置
    training_args = TrainingArguments(
        # 使用argparse参数
        output_dir=args.output_dir,
        overwrite_output_dir=args.overwrite_output_dir,
        num_train_epochs=args.num_train_epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        save_steps=args.save_steps,
        save_strategy=args.save_strategy,
        save_total_limit=args.save_total_limit,
        dataloader_num_workers=args.dataloader_num_workers,
        report_to=args.report_to if local_rank <= 0 else "none",
        run_name=args.run_name,
        
        # 其他固定参数
        weight_decay=0.01,
        adam_beta1=0.9,
        adam_beta2=0.999,
        adam_epsilon=1e-8,
        max_grad_norm=1.0,
        lr_scheduler_type="linear",
        warmup_steps=100,
        logging_dir="./logs",
        logging_steps=10,
        ddp_backend="nccl" if torch.cuda.is_available() else "gloo",
        ddp_find_unused_parameters=False,
        dataloader_pin_memory=True,
        fp16=torch.cuda.is_available(),
        seed=42,
        remove_unused_columns=False,
        push_to_hub=False,
    )
    
    events = TrainingEvents.create()

    # 创建Trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        data_collator=data_collator,
        tokenizer=tokenizer,
        callbacks=[HyperPodEventsCallback(events)],
    )

    try:
        # 开始训练
        logger.info("开始训练...")
        train_result = trainer.train()

        # 保存最终模型（Trainer 循环之外的保存，同样记为一次 checkpoint）
        with checkpoint_events(events, trainer.state.global_step):
            trainer.save_model(f"{args.output_dir}/final_model")
            tokenizer.save_pretrained(f"{args.output_dir}/final_model")
    finally:
        if events:
            events.close()

if __name__ == "__main__":
    main()
