/**
 * Shared child_process helpers.
 *
 * Before this module, ~7 files each independently wrote:
 *     const { exec } = require('child_process');
 *     const { promisify } = require('util');
 *     const execAsync = promisify(exec);
 * which is identical boilerplate. This module is the single seam for that
 * setup so future cross-cutting concerns (timeout defaults, logging, error
 * normalization) have one place to live.
 *
 * IMPORTANT — behavior parity: the exports below are the SAME function
 * references as Node's `child_process` (exec/execSync/spawn) plus the standard
 * `promisify(exec)`. Swapping a file's local `promisify(exec)` for an import of
 * `execAsync` here is therefore behavior-identical; call sites that pass option
 * objects (encoding/timeout/env/maxBuffer/shell) keep passing them unchanged.
 */
const { exec, execSync, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

module.exports = { exec, execSync, spawn, execAsync };
