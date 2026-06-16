/**
 * Training Job Manager
 *
 * 管理所有训练相关的 API：
 * - 训练启动 (Torch/SageMaker/LlamaFactory/MS-Swift/Script)
 * - 配置保存/加载
 * - 作业查询 (HyperPod Jobs/RayJobs)
 *
 * 从 index.js 迁移，Phase 1.1
 * 创建日期: 2025-01-06
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);
const { renderTemplate } = require('./utils/renderTemplate');
const {
  formatPythonParams,
  mlflowPatches,
  logMonitoringPatch,
  appendEnvPatches,
  storageMountPatches,
} = require('./utils/trainingPatches');

// 依赖注入
let broadcast = null;
let executeKubectl = null;

/**
 * 初始化模块依赖
 */
function initialize(deps) {
  broadcast = deps.broadcast;
  executeKubectl = deps.executeKubectl;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 优化错误消息，使其更友好
 */
function optimizeErrorMessage(errorMessage) {
  if (!errorMessage) return 'Unknown error';

  if (errorMessage.includes(`doesn't have a resource type "hyperpodpytorchjob"`)) {
    return 'No HyperPod training jobs found (HyperPod operator may not be installed)';
  }
  if (errorMessage.includes(`doesn't have a resource type "rayjob"`)) {
    return 'No RayJobs found (Ray operator may not be installed)';
  }
  if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
    return 'Resource not found - this may be normal if no resources have been created yet';
  }
  if (errorMessage.includes('connection refused') || errorMessage.includes('unable to connect')) {
    return 'Unable to connect to Kubernetes cluster. Please check if the cluster is accessible.';
  }

  return errorMessage;
}

/**
 * 统一的训练 YAML 部署函数
 */
async function deployTrainingYaml(recipeType, jobName, yamlContent) {
  try {
    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingsDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingsDir)) {
      fs.mkdirSync(trainingsDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    const tempFileName = `${recipeType}-${jobName}-${Date.now()}.yaml`;
    const tempFilePath = path.join(tempDir, tempFileName);
    await fs.writeFile(tempFilePath, yamlContent);

    // 写入永久文件（用于记录）
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const permanentFileName = `${recipeType}_${timestamp}.yaml`;
    const permanentFilePath = path.join(trainingsDir, permanentFileName);
    await fs.writeFile(permanentFilePath, yamlContent);

    console.log(`${recipeType} training YAML saved to: ${permanentFilePath}`);

    // 应用YAML配置
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`);
    console.log(`${recipeType} training kubectl apply output:`, applyOutput);

    // 清理临时文件
    fs.unlinkSync(tempFilePath);

    // 发送WebSocket广播
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched ${recipeType} training job: ${jobName}`,
      output: applyOutput
    });

    return {
      success: true,
      permanentFileName,
      permanentFilePath,
      applyOutput
    };

  } catch (error) {
    // 发送错误广播
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `${recipeType} training launch failed: ${error.message}`
    });

    throw error;
  }
}

// ============================================================
// 训练启动 API
// ============================================================

/**
 * POST /launch-torch-training
 * 生成并部署 HyperPod Torch 训练任务
 */
router.post('/launch-torch-training', async (req, res) => {
  try {
    console.log('Raw torch training request body:', JSON.stringify(req.body, null, 2));

    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 16,
      entryPythonScriptPath,
      pythonScriptParameters,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Torch training launch request parsed:', {
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      entryPythonScriptPath,
      pythonScriptParameters,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!entryPythonScriptPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Python Script Path is required'
      });
    }

    if (!pythonScriptParameters) {
      return res.status(400).json({
        success: false,
        error: 'Python Script Parameters are required'
      });
    }

    // 渲染训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-torch-template.yaml');
    const extraPatches = [
      ...mlflowPatches(mlflowTrackingUri),
      logMonitoringPatch(logMonitoringConfig),
    ].filter(Boolean);

    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: trainingJobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        NPROC_PER_NODE: nprocPerNode,
        REPLICAS: replicas,
        EFA_PER_NODE: efaCount,
        TORCH_RECIPE_PY_PATH: entryPythonScriptPath,
        TORCH_RECIPE_PY_PARAMS: formatPythonParams(pythonScriptParameters),
        MLFLOW_TRACKING_URI: mlflowTrackingUri && mlflowTrackingUri.trim() ? mlflowTrackingUri : null,
      },
      patches: extraPatches,
    });

    console.log('Generated torch training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();

    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `torch-training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成部署文件名（保存到deployments/trainings/目录）
    const deploymentFileName = `torch_${timestamp}.yaml`;
    const deploymentFilePath = path.join(__dirname, '../deployments/trainings', deploymentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Torch training YAML written to temp file: ${tempFilePath}`);

    // 写入部署文件（保存到deployments/trainings/目录）
    await fs.writeFile(deploymentFilePath, newYamlContent);
    console.log(`Torch training YAML saved to deployments: ${deploymentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000);
    console.log('Torch training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched torch training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Torch training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: deploymentFileName,
      savedTemplatePath: deploymentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Torch training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });

    const errorMessage = error.message || error.toString() || 'Unknown error occurred';

    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Torch training launch failed: ${errorMessage}`
    });

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /launch-sagemaker-job
 * 生成并部署 SageMaker 训练任务
 */
router.post('/launch-sagemaker-job', async (req, res) => {
  try {
    console.log('Raw SageMaker job request body:', JSON.stringify(req.body, null, 2));

    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      smJobDir,
      entryPythonScriptPath,
      pythonScriptParameters,
      enableSpotTraining = false,
      maxWaitTimeInSeconds = 1800
    } = req.body;

    console.log('SageMaker job launch request parsed:', {
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      smJobDir,
      entryPythonScriptPath,
      pythonScriptParameters
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!smJobDir) {
      return res.status(400).json({
        success: false,
        error: 'SageMaker Job Dir is required'
      });
    }

    if (!entryPythonScriptPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Python Script Path is required'
      });
    }

    if (!pythonScriptParameters) {
      return res.status(400).json({
        success: false,
        error: 'Python Script Parameters are required'
      });
    }

    // 动态获取AWS资源信息
    const awsHelpers = require('./utils/awsHelpers');
    const bucketName = awsHelpers.getCurrentS3Bucket();
    const devAdminRoleArn = await awsHelpers.getDevAdminRoleArn();

    console.log('Dynamic AWS resources:', { bucketName, devAdminRoleArn });

    // 渲染SageMaker作业模板
    const templatePath = path.join(__dirname, '../templates/sagemaker-job-template.yaml');
    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: trainingJobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        REPLICAS: replicas,
        NPROC_PER_NODE: nprocPerNode,
        ENTRY_PYTHON_PATH: entryPythonScriptPath,
        PYTHON_SCRIPT_PARAMS: formatPythonParams(pythonScriptParameters),
        S3_BUCKET: bucketName,
        SAGEMAKER_JOB_DIR: smJobDir,
        SAGEMAKER_DEV_ROLE: devAdminRoleArn,
        ENABLE_SPOT: enableSpotTraining,
        MAX_WAIT_SECONDS: maxWaitTimeInSeconds,
      },
    });

    console.log('Generated SageMaker job YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();

    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `sagemaker-job-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到deployments/trainings/目录）
    const permanentFileName = `sagemaker_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../deployments/trainings', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`SageMaker job YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到deployments/trainings/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`SageMaker job YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000);
    console.log('SageMaker job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播SageMaker作业启动状态更新
    broadcast({
      type: 'sagemaker_launch',
      status: 'success',
      message: `Successfully launched SageMaker job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `SageMaker job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('SageMaker job launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });

    const errorMessage = error.message || error.toString() || 'Unknown error occurred';

    broadcast({
      type: 'sagemaker_launch',
      status: 'error',
      message: `SageMaker job launch failed: ${errorMessage}`
    });

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /launch-training
 * 生成并部署 HyperPod 训练任务 - LlamaFactory
 */
router.post('/launch-training', async (req, res) => {
  try {
    console.log('Raw request body:', JSON.stringify(req.body, null, 2));

    const {
      trainingJobName,
      dockerImage = 'pytorch/pytorch:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 0,
      lmfRecipeRunPath,
      lmfRecipeYamlFile,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Training launch request parsed:', {
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      lmfRecipeRunPath,
      lmfRecipeYamlFile,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!lmfRecipeRunPath) {
      return res.status(400).json({
        success: false,
        error: 'LlamaFactory Recipe Run Path is required'
      });
    }

    if (!lmfRecipeYamlFile) {
      return res.status(400).json({
        success: false,
        error: 'LlamaFactory Config YAML File Name is required'
      });
    }

    // 渲染训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-lmf-template.yaml');
    const extraPatches = [
      ...mlflowPatches(mlflowTrackingUri),
      logMonitoringPatch(logMonitoringConfig),
    ].filter(Boolean);

    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: trainingJobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        NPROC_PER_NODE: nprocPerNode,
        REPLICAS: replicas,
        EFA_PER_NODE: efaCount,
        LMF_RECIPE_RUN_PATH: lmfRecipeRunPath,
        LMF_RECIPE_YAML_FILE: lmfRecipeYamlFile,
        MLFLOW_TRACKING_URI: mlflowTrackingUri && mlflowTrackingUri.trim() ? mlflowTrackingUri : null,
      },
      patches: extraPatches,
    });

    console.log('Generated training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();

    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成部署文件名（保存到deployments/trainings/目录）
    const deploymentFileName = `lma_${timestamp}.yaml`;
    const deploymentFilePath = path.join(__dirname, '../deployments/trainings', deploymentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Training YAML written to temp file: ${tempFilePath}`);

    // 写入部署文件（保存到deployments/trainings/目录）
    await fs.writeFile(deploymentFilePath, newYamlContent);
    console.log(`Training YAML saved to deployments: ${deploymentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000);
    console.log('Training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: deploymentFileName,
      savedTemplatePath: deploymentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });

    const errorMessage = error.message || error.toString() || 'Unknown error occurred';

    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Training launch failed: ${errorMessage}`
    });

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /launch-msswift-training
 * 启动 MS-Swift 训练
 */
router.post('/launch-msswift-training', async (req, res) => {
  try {
    console.log('MS-Swift training launch request:', JSON.stringify(req.body, null, 2));

    const {
      trainingJobName,
      dockerImage = 'pytorch/pytorch:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 0,
      msswiftRecipeRunPath,
      msswiftCommandType,
      msswiftRecipeYamlFile,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!msswiftRecipeRunPath) {
      return res.status(400).json({
        success: false,
        error: 'MS-Swift Recipe Run Path is required'
      });
    }

    if (!msswiftCommandType) {
      return res.status(400).json({
        success: false,
        error: 'MS-Swift Command Type is required'
      });
    }

    if (!msswiftRecipeYamlFile) {
      return res.status(400).json({
        success: false,
        error: 'MS-Swift Config YAML File Name is required'
      });
    }

    const templatePath = path.join(__dirname, '../templates/hyperpod-training-msswift-template.yaml');
    const extraPatches = [
      ...mlflowPatches(mlflowTrackingUri),
      logMonitoringPatch(logMonitoringConfig),
    ].filter(Boolean);

    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: trainingJobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        NPROC_PER_NODE: nprocPerNode,
        REPLICAS: replicas,
        EFA_PER_NODE: efaCount,
        MSSWIFT_RECIPE_RUN_PATH: msswiftRecipeRunPath,
        MSSWIFT_COMMAND_TYPE: msswiftCommandType,
        MSSWIFT_RECIPE_YAML_FILE: msswiftRecipeYamlFile,
        MLFLOW_TRACKING_URI: mlflowTrackingUri && mlflowTrackingUri.trim() ? mlflowTrackingUri : null,
      },
      patches: extraPatches,
    });

    const timestamp = Date.now();

    const tempFileName = `training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    const deploymentFileName = `msswift_${timestamp}.yaml`;
    const deploymentFilePath = path.join(__dirname, '../deployments/trainings', deploymentFileName);

    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`MS-Swift training YAML written to temp file: ${tempFilePath}`);

    await fs.writeFile(deploymentFilePath, newYamlContent);
    console.log(`MS-Swift training YAML saved to deployments: ${deploymentFilePath}`);

    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000);
    console.log('MS-Swift training job apply output:', applyOutput);

    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      console.log(`Temp file deleted: ${tempFilePath}`);
    }

    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `MS-Swift training job ${trainingJobName} launched successfully`
    });

    res.json({
      success: true,
      message: `MS-Swift training job ${trainingJobName} launched successfully`,
      jobName: trainingJobName,
      savedTemplate: deploymentFileName,
      savedTemplatePath: deploymentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('MS-Swift training launch error:', error);

    const errorMessage = error.message || error.toString() || 'Unknown error occurred';

    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `MS-Swift training launch failed: ${errorMessage}`
    });

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /launch-script-training
 * 生成并部署 HyperPod Script 训练任务
 */
router.post('/launch-script-training', async (req, res) => {
  try {
    console.log('Raw script training request body:', JSON.stringify(req.body, null, 2));

    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 16,
      projectPath,
      entryPath,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Script training launch request parsed:', {
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      projectPath,
      entryPath,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!projectPath) {
      return res.status(400).json({
        success: false,
        error: 'Project Path is required'
      });
    }

    if (!entryPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Script Path is required'
      });
    }

    // 渲染Script训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-script-template.yaml');
    const extraPatches = [
      ...mlflowPatches(mlflowTrackingUri),
      logMonitoringPatch(logMonitoringConfig),
    ].filter(Boolean);

    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: trainingJobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        NPROC_PER_NODE: nprocPerNode,
        REPLICAS: replicas,
        EFA_PER_NODE: efaCount,
        SCRIPT_RECIPE_PROJECT_PATH: projectPath,
        SCRIPT_RECIPE_ENTRY_PATH: entryPath,
        MLFLOW_TRACKING_URI: mlflowTrackingUri && mlflowTrackingUri.trim() ? mlflowTrackingUri : null,
      },
      patches: extraPatches,
    });

    console.log('Generated script training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();

    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `script-training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到templates/training/目录）
    const permanentFileName = `script_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../templates/training', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保templates/training目录存在
    const trainingTemplateDir = path.join(__dirname, '../templates/training');
    if (!fs.existsSync(trainingTemplateDir)) {
      fs.mkdirSync(trainingTemplateDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Script training YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到templates/training/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`Script training YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000);
    console.log('Script training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched script training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Script training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Script training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });

    const errorMessage = error.message || error.toString() || 'Unknown error occurred';

    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Script training launch failed: ${errorMessage}`
    });

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * POST /launch-verl-training
 * 生成并部署 VERL 训练任务
 */
router.post('/launch-verl-training', async (req, res) => {
  try {
    console.log('Raw VERL training request body:', JSON.stringify(req.body, null, 2));

    const {
      jobName,
      instanceType = 'ml.g5.12xlarge',
      entryPointPath,
      dockerImage,
      workerReplicas = 1,
      gpuPerNode = 4,
      efaPerNode = 1,
      mounts = ['s3'],
      recipeType
    } = req.body;

    console.log('VERL training launch request parsed:', {
      jobName,
      instanceType,
      entryPointPath,
      dockerImage,
      workerReplicas,
      gpuPerNode,
      efaPerNode,
      recipeType
    });

    // 验证必需参数
    if (!jobName) {
      return res.status(400).json({
        success: false,
        error: 'Job name is required'
      });
    }

    if (!entryPointPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry point path is required'
      });
    }

    if (!dockerImage) {
      return res.status(400).json({
        success: false,
        error: 'Docker image is required'
      });
    }

    // 计算总节点数 = 1 (head) + worker replicas
    const totNumNodes = 1 + workerReplicas;

    // 渲染VERL训练任务模板
    const templatePath = path.join(__dirname, '../templates/verl-training-template.yaml');
    const headSpec = ['spec', 'rayClusterSpec', 'headGroupSpec', 'template', 'spec'];
    const workerSpec = ['spec', 'rayClusterSpec', 'workerGroupSpecs', 0, 'template', 'spec'];
    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: jobName,
        INSTANCE_TYPE: instanceType,
        ENTRY_POINT_PATH: entryPointPath,
        DOCKER_IMAGE: dockerImage,
        WORKER_REPLICAS: workerReplicas,
        MAX_REPLICAS: Math.max(3, workerReplicas + 2),
        GPU_PER_NODE: gpuPerNode,
        EFA_PER_NODE: efaPerNode,
        TOT_NUM_NODES: totNumNodes,
      },
      patches: storageMountPatches(mounts, {
        mountPaths: [[...headSpec, 'containers', 0, 'volumeMounts'], [...workerSpec, 'containers', 0, 'volumeMounts']],
        volumePaths: [[...headSpec, 'volumes'], [...workerSpec, 'volumes']],
      }),
    });

    console.log('Generated VERL YAML content preview:', newYamlContent.substring(0, 500) + '...');

    // 使用统一的部署函数
    const deployResult = await deployTrainingYaml('verl', jobName, newYamlContent);

    res.json({
      success: true,
      message: `VERL training job "${jobName}" launched successfully`,
      jobName: jobName,
      templateUsed: 'verl-training-template.yaml',
      savedTemplate: deployResult.permanentFileName,
      savedTemplatePath: deployResult.permanentFilePath,
      output: deployResult.applyOutput
    });

  } catch (error) {
    console.error('VERL training launch error:', error);

    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error occurred'
    });
  }
});

// ============================================================
// 通用 Job 启动 API (sh-based, 无框架绑定)
// ============================================================

/**
 * POST /launch-hyperpodrun-job
 * 通用 HyperPod PyTorchJob: .sh 入口，用户自行调用 hyperpodrun。
 */
router.post('/launch-hyperpodrun-job', async (req, res) => {
  try {
    const {
      jobName,
      dockerImage,
      instanceType,
      entryScriptPath,
      replicas = 1,
      nprocPerNode = 1,
      efaPerNode = 0,
      envVars = [],
    } = req.body;

    if (!jobName) return res.status(400).json({ success: false, error: 'Job name is required' });
    if (!dockerImage) return res.status(400).json({ success: false, error: 'Docker image is required' });
    if (!instanceType) return res.status(400).json({ success: false, error: 'Instance type is required' });
    if (!entryScriptPath) return res.status(400).json({ success: false, error: 'Entry script path is required' });

    const templatePath = path.join(__dirname, '../templates/hyperpodrun-job-template.yaml');
    const envPath = ['spec', 'replicaSpecs', 0, 'template', 'spec', 'containers', 0, 'env'];

    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: jobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        ENTRY_SCRIPT_PATH: entryScriptPath,
        REPLICAS: replicas,
        NPROC_PER_NODE: nprocPerNode,
        EFA_PER_NODE: efaPerNode,
      },
      patches: appendEnvPatches(envVars, [envPath]),
    });

    const deployResult = await deployTrainingYaml('hyperpodrun-job', jobName, newYamlContent);
    res.json({
      success: true,
      message: `HyperPod job "${jobName}" launched successfully`,
      jobName,
      savedTemplate: deployResult.permanentFileName,
      savedTemplatePath: deployResult.permanentFilePath,
      output: deployResult.applyOutput,
    });
  } catch (error) {
    console.error('HyperPod job launch error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
});


/**
 * POST /launch-rayjob
 * 通用 RayJob: .sh 入口，head+worker 同规格，env 同时写入两边容器。
 */
router.post('/launch-rayjob', async (req, res) => {
  try {
    const {
      jobName,
      dockerImage,
      instanceType,
      entryScriptPath,
      workerReplicas = 1,
      gpuPerNode = 1,
      efaPerNode = 0,
      maxRunHours = 24,
      envVars = [],
    } = req.body;

    if (!jobName) return res.status(400).json({ success: false, error: 'Job name is required' });
    if (!dockerImage) return res.status(400).json({ success: false, error: 'Docker image is required' });
    if (!instanceType) return res.status(400).json({ success: false, error: 'Instance type is required' });
    if (!entryScriptPath) return res.status(400).json({ success: false, error: 'Entry script path is required' });

    const templatePath = path.join(__dirname, '../templates/rayjob-template.yaml');
    const headEnvPath = ['spec', 'rayClusterSpec', 'headGroupSpec', 'template', 'spec', 'containers', 0, 'env'];
    const workerEnvPath = ['spec', 'rayClusterSpec', 'workerGroupSpecs', 0, 'template', 'spec', 'containers', 0, 'env'];

    const newYamlContent = renderTemplate(templatePath, {
      values: {
        JOB_NAME: jobName,
        DOCKER_IMAGE: dockerImage,
        INSTANCE_TYPE: instanceType,
        ENTRY_SCRIPT_PATH: entryScriptPath,
        WORKER_REPLICAS: workerReplicas,
        MAX_REPLICAS: Math.max(3, workerReplicas + 2),
        GPU_PER_NODE: gpuPerNode,
        EFA_PER_NODE: efaPerNode,
        DEADLINE_SECONDS: maxRunHours * 3600,
      },
      patches: appendEnvPatches(envVars, [headEnvPath, workerEnvPath]),
    });

    const deployResult = await deployTrainingYaml('rayjob', jobName, newYamlContent);
    res.json({
      success: true,
      message: `RayJob "${jobName}" launched successfully`,
      jobName,
      savedTemplate: deployResult.permanentFileName,
      savedTemplatePath: deployResult.permanentFilePath,
      output: deployResult.applyOutput,
    });
  } catch (error) {
    console.error('RayJob launch error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
});

// ============================================================
// 通用 Job 配置保存/加载 API
// ============================================================

function makeConfigRoutes(slug, defaults) {
  router.post(`/${slug}/save`, async (req, res) => {
    try {
      const configPath = path.join(__dirname, `../config/${slug}.json`);
      const configDir = path.join(__dirname, '../config');
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(req.body, null, 2));
      res.json({ success: true, message: `${slug} configuration saved` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get(`/${slug}/load`, async (req, res) => {
    try {
      const configPath = path.join(__dirname, `../config/${slug}.json`);
      if (!fs.existsSync(configPath)) {
        return res.json({ success: true, config: defaults, isDefault: true });
      }
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      res.json({ success: true, config, isDefault: false });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

makeConfigRoutes('hyperpodrun-job-config', {
  jobName: 'hyperpodrun-job-1',
  dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
  instanceType: '',
  entryScriptPath: '/fsx/my-project/run.sh',
  replicas: 1,
  nprocPerNode: 1,
  efaPerNode: 0,
  envVars: [],
});


makeConfigRoutes('rayjob-config', {
  jobName: 'rayjob-1',
  dockerImage: '',
  instanceType: '',
  entryScriptPath: '/fsx/my-project/run.sh',
  workerReplicas: 1,
  gpuPerNode: 1,
  efaPerNode: 0,
  maxRunHours: 24,
  envVars: [],
});

// ============================================================
// 配置保存/加载 API
// ============================================================

/**
 * POST /llamafactory-config/save
 * 保存 LlamaFactory 配置
 */
router.post('/llamafactory-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/llamafactory-config.json');

    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('LlamaFactory config saved:', config);

    res.json({
      success: true,
      message: 'LlamaFactory configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving training config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /llamafactory-config/load
 * 加载 LlamaFactory 配置
 */
router.get('/llamafactory-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/llamafactory-config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        trainingJobName: 'lmf-v1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op-v2:latest',
        instanceType: 'ml.g6.12xlarge',
        nprocPerNode: 4,
        replicas: 1,
        efaCount: 1,
        lmfRecipeRunPath: '/s3/train-recipes/llama-factory-project/',
        lmfRecipeYamlFile: 'qwen_full_dist_template.yaml',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };

      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('LlamaFactory config loaded:', config);

    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading training config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /msswift-config/save
 * 保存 MS-Swift 配置
 */
router.post('/msswift-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/msswift-config.json');

    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('MS-Swift config saved:', config);

    res.json({
      success: true,
      message: 'MS-Swift configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving MS-Swift config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /msswift-config/load
 * 加载 MS-Swift 配置
 */
router.get('/msswift-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/msswift-config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        trainingJobName: 'msswift-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op-v2:latest',
        instanceType: 'ml.g6.12xlarge',
        nprocPerNode: 4,
        replicas: 1,
        efaCount: 1,
        msswiftRecipeRunPath: '/s3/train-recipes/ms-swift-project/',
        msswiftRecipeYamlFile: 'yaml_template.yaml',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };

      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('MS-Swift config loaded:', config);

    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading MS-Swift config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /msswift-commands
 * 获取 MS-Swift 命令列表
 */
router.get('/msswift-commands', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/msswift-commands.json');

    if (!fs.existsSync(configPath)) {
      return res.json({
        success: true,
        commands: {
          "megatron rlhf": "swift.cli._megatron.rlhf",
          "swift sft": "swift.cli.sft"
        }
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    res.json({
      success: true,
      commands: config.commands
    });
  } catch (error) {
    console.error('Error loading MS-Swift commands:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /script-config/save
 * 保存 Script 配置
 */
router.post('/script-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/script-config.json');

    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Script config saved:', config);

    res.json({
      success: true,
      message: 'Script configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving script config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /script-config/load
 * 加载 Script 配置
 */
router.get('/script-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/script-config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        trainingJobName: 'hypd-recipe-script-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        projectPath: '/s3/training_code/my-training-project/',
        entryPath: 'train.py',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };

      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('Script config loaded:', config);

    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading script config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /torch-config/save
 * 保存 Torch 配置
 */
router.post('/torch-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/torch-config.json');

    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Torch config saved:', config);

    res.json({
      success: true,
      message: 'Torch configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving torch config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /torch-config/load
 * 加载 Torch 配置
 */
router.get('/torch-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/torch-config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        trainingJobName: 'hypd-recipe-torch-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        entryPythonScriptPath: '/s3/training_code/model-training-with-hyperpod-training-operator/torch-training.py',
        pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };

      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('Torch config loaded:', config);

    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading torch config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /sagemaker-config/save
 * 保存 SageMaker 配置
 */
router.post('/sagemaker-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/sagemaker-config.json');

    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('SageMaker config saved:', config);

    res.json({
      success: true,
      message: 'SageMaker configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving SageMaker config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /sagemaker-config/load
 * 加载 SageMaker 配置
 */
router.get('/sagemaker-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/sagemaker-config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        trainingJobName: 'sagemaker-job',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        smJobDir: 'sample-job-1',
        entryPythonScriptPath: 'codes/launcher.py',
        pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
        enableSpotTraining: false,
        maxWaitTimeInSeconds: 1800
      };

      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('SageMaker config loaded:', config);

    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading SageMaker config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /verl-config/save
 * 保存 VERL 配置
 */
router.post('/verl-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/verl-config.json');

    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('VERL config saved:', config);

    res.json({
      success: true,
      message: 'VERL configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving VERL config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /verl-config/load
 * 加载 VERL 配置
 */
router.get('/verl-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/verl-config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        jobName: 'verl-training-a1',
        instanceType: 'ml.g5.12xlarge',
        entryPointPath: 'verl-project/src/qwen-3b-grpo-kuberay.sh',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/hypd-verl:latest',
        workerReplicas: 1,
        gpuPerNode: 4,
        efaPerNode: 1
      };

      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }

    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);

    console.log('VERL config loaded:', config);

    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading VERL config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ============================================================
// 作业查询 API
// ============================================================

/**
 * GET /training-jobs
 * 统一的训练作业 API - 合并 HyperPod 和 RayJob
 */
router.get('/training-jobs', async (req, res) => {
  try {
    console.log('🔍 [API Call] /api/training-jobs requested from:', req.ip || req.connection.remoteAddress);

    const allJobs = [];

    // 获取 HyperPod 作业
    let hyperpodJobs = [];
    try {
      const hyperpodOutput = await executeKubectl('get hyperpodpytorchjob -o json');
      const hyperpodResult = JSON.parse(hyperpodOutput);
      hyperpodJobs = hyperpodResult.items.map(job => ({
        name: job.metadata.name,
        namespace: job.metadata.namespace || 'default',
        creationTimestamp: job.metadata.creationTimestamp,
        status: job.status || {},
        type: 'hyperpod',
        spec: {
          replicas: job.spec?.replicaSpecs?.[0]?.replicas || 0,
          nprocPerNode: job.spec?.nprocPerNode || 0
        }
      }));
    } catch (error) {
      console.log('No HyperPod jobs found:', error.message);
    }

    // 获取 RayJob 作业
    let rayJobs = [];
    try {
      const rayjobOutput = await executeKubectl('get rayjobs -o json');
      const rayjobResult = JSON.parse(rayjobOutput);
      rayJobs = rayjobResult.items.map(rayJob => {
        const workerReplicas = rayJob.spec?.rayClusterSpec?.workerGroupSpecs?.reduce((total, group) =>
          total + (group.replicas || 0), 0) || 0;
        const totalReplicas = workerReplicas + 1;

        return {
          name: rayJob.metadata.name,
          namespace: rayJob.metadata.namespace || 'default',
          creationTimestamp: rayJob.metadata.creationTimestamp,
          status: rayJob.status || {},
          type: 'rayjob',
          spec: {
            replicas: totalReplicas
          }
        };
      });
    } catch (error) {
      console.log('No RayJobs found:', error.message);
    }

    let kubeflowJobs = [];

    // 合并所有作业
    allJobs.push(...hyperpodJobs, ...rayJobs, ...kubeflowJobs);

    console.log(`Aggregated ${allJobs.length} training jobs:`, allJobs.map(j => `${j.name} (${j.type})`));

    res.json({
      success: true,
      jobs: allJobs
    });
  } catch (error) {
    console.error('Test aggregation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /hyperpod-jobs
 * 获取纯 HyperPod 训练任务
 */
router.get('/hyperpod-jobs', async (req, res) => {
  try {
    console.log('Fetching HyperPod PytorchJobs only...');

    let hyperpodJobs = [];
    try {
      const hyperpodOutput = await executeKubectl('get hyperpodpytorchjob -o json');
      const hyperpodResult = JSON.parse(hyperpodOutput);
      hyperpodJobs = hyperpodResult.items.map(job => ({
        name: job.metadata.name,
        namespace: job.metadata.namespace || 'default',
        creationTimestamp: job.metadata.creationTimestamp,
        status: job.status || {},
        type: 'hyperpod',
        spec: {
          replicas: job.spec?.replicaSpecs?.[0]?.replicas || 0,
          nprocPerNode: job.spec?.nprocPerNode || 0
        }
      }));
    } catch (error) {
      const optimizedMessage = optimizeErrorMessage(error.message);
      console.log('No HyperPod PytorchJobs found or error:', optimizedMessage);
    }

    console.log(`Found ${hyperpodJobs.length} HyperPod training jobs:`,
                hyperpodJobs.map(j => j.name));

    res.json({
      success: true,
      jobs: hyperpodJobs
    });
  } catch (error) {
    console.error('Error fetching HyperPod jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      jobs: []
    });
  }
});

/**
 * DELETE /hyperpod-jobs/:jobName
 * 删除指定的 HyperPod 训练任务
 */
router.delete('/hyperpod-jobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Deleting training job: ${jobName}`);

    const output = await executeKubectl(`delete hyperpodpytorchjob ${jobName}`);
    console.log('Delete output:', output);

    // 广播删除状态更新
    broadcast({
      type: 'training_job_deleted',
      status: 'success',
      message: `Training job "${jobName}" deleted successfully`,
      jobName: jobName
    });

    res.json({
      success: true,
      message: `Training job "${jobName}" deleted successfully`,
      output: output
    });
  } catch (error) {
    console.error('Error deleting training job:', error);

    broadcast({
      type: 'training_job_deleted',
      status: 'error',
      message: `Failed to delete training job: ${error.message}`
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /hyperpod-jobs/:jobName/pods
 * 获取 HyperPod 训练任务关联的 pods
 */
router.get('/hyperpod-jobs/:jobName/pods', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Fetching pods for training job: ${jobName}`);

    // 获取所有pods，然后筛选出属于该训练任务的pods
    const output = await executeKubectl('get pods -o json');
    const result = JSON.parse(output);

    // 筛选出属于该训练任务的pods
    const trainingPods = result.items.filter(pod => {
      const labels = pod.metadata.labels || {};
      const ownerReferences = pod.metadata.ownerReferences || [];

      return labels['training-job-name'] === jobName ||
             labels['app'] === jobName ||
             ownerReferences.some(ref => ref.name === jobName) ||
             pod.metadata.name.includes(jobName);
    });

    const pods = trainingPods.map(pod => ({
      name: pod.metadata.name,
      namespace: pod.metadata.namespace || 'default',
      status: pod.status.phase,
      creationTimestamp: pod.metadata.creationTimestamp,
      nodeName: pod.spec.nodeName,
      containerStatuses: pod.status.containerStatuses || []
    }));

    console.log(`Found ${pods.length} pods for training job ${jobName}:`, pods.map(p => p.name));

    res.json({
      success: true,
      pods: pods
    });
  } catch (error) {
    console.error('Error fetching training job pods:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      pods: []
    });
  }
});


/**
 * GET /rayjobs
 * 获取所有 RayJob
 */
router.get('/rayjobs', async (req, res) => {
  try {
    const output = await executeKubectl('get rayjobs -o json');
    const rayjobs = JSON.parse(output);
    res.json({
      items: rayjobs.items || [],
      kind: 'RayJobList',
      apiVersion: rayjobs.apiVersion || 'ray.io/v1'
    });
  } catch (error) {
    console.error('RayJobs fetch error:', error);
    res.json({
      items: [],
      kind: 'RayJobList',
      apiVersion: 'ray.io/v1'
    });
  }
});

/**
 * DELETE /rayjobs/:jobName
 * 删除指定的 RayJob
 */
router.delete('/rayjobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Deleting RayJob: ${jobName}`);

    const output = await executeKubectl(`delete rayjob ${jobName}`);
    console.log('RayJob delete output:', output);

    // 发送WebSocket广播
    broadcast({
      type: 'rayjob_deleted',
      status: 'success',
      message: `RayJob "${jobName}" deleted successfully`,
      jobName: jobName
    });

    res.json({
      success: true,
      message: `RayJob "${jobName}" deleted successfully`,
      output: output
    });
  } catch (error) {
    console.error('Error deleting RayJob:', error);

    broadcast({
      type: 'rayjob_deleted',
      status: 'error',
      message: `Failed to delete RayJob: ${error.message}`
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /rayjobs/:jobName/pods
 * 获取指定 RayJob 的 pods
 */
router.get('/rayjobs/:jobName/pods', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Fetching pods for RayJob: ${jobName}`);

    // 首先获取RayJob信息来找到对应的RayCluster名称
    const rayjobOutput = await executeKubectl(`get rayjob ${jobName} -o json`);
    const rayJob = JSON.parse(rayjobOutput);
    const rayClusterName = rayJob.status?.rayClusterName;

    let allPods = [];

    // 获取属于该RayCluster的所有pods（如果RayCluster存在）
    if (rayClusterName) {
      const rayClusterPodsOutput = await executeKubectl(`get pods -l ray.io/cluster=${rayClusterName} -o json`);
      const rayClusterResult = JSON.parse(rayClusterPodsOutput);

      const rayClusterPods = rayClusterResult.items.map(pod => ({
        name: pod.metadata.name,
        status: pod.status.phase,
        ready: pod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
        restartCount: pod.status.containerStatuses?.[0]?.restartCount || 0,
        creationTimestamp: pod.metadata.creationTimestamp,
        node: pod.spec.nodeName,
        type: pod.metadata.labels?.['ray.io/node-type'] || 'ray-node'
      }));

      allPods.push(...rayClusterPods);
      console.log(`Found ${rayClusterPods.length} RayCluster pods for ${jobName} (cluster: ${rayClusterName})`);
    }

    // 获取Job submitter pod（使用job-name标签）
    try {
      const jobPodsOutput = await executeKubectl(`get pods -l job-name=${jobName} -o json`);
      const jobResult = JSON.parse(jobPodsOutput);

      const jobSubmitterPods = jobResult.items.map(pod => ({
        name: pod.metadata.name,
        status: pod.status.phase,
        ready: pod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
        restartCount: pod.status.containerStatuses?.[0]?.restartCount || 0,
        creationTimestamp: pod.metadata.creationTimestamp,
        node: pod.spec.nodeName,
        type: 'job-submitter'
      }));

      allPods.push(...jobSubmitterPods);
      console.log(`Found ${jobSubmitterPods.length} job submitter pods for ${jobName}`);
    } catch (jobError) {
      console.log(`No job submitter pods found for ${jobName}: ${jobError.message}`);
    }

    console.log(`Total ${allPods.length} pods found for RayJob ${jobName}`);

    res.json({
      success: true,
      pods: allPods
    });
  } catch (error) {
    console.error('Error fetching RayJob pods:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      pods: []
    });
  }
});

// ============================================================
// 导出模块
// ============================================================

module.exports = {
  router,
  initialize,
  // 导出辅助函数供其他模块使用
  optimizeErrorMessage,
  deployTrainingYaml
};
