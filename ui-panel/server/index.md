## 📋 完整 API 列表（按功能分类）

### 1️⃣ 集群管理 (Cluster Management)

GET    /api/cluster-status                    # 集群状态（V2优化版）
GET    /api/cluster/info                      # 集群信息
GET    /api/cluster/nodegroups                # 节点组列表
GET    /api/cluster/availability-zones        # 可用区列表
GET    /api/cluster/subnets                   # 子网列表
GET    /api/cluster/generate-cidr             # 生成CIDR
POST   /api/cluster/validate-cidr             # 验证CIDR
POST   /api/cluster/create-eks                # 创建EKS集群
POST   /api/cluster/create-hyperpod           # 创建HyperPod集群
POST   /api/cluster/import                    # 导入集群
POST   /api/cluster/test-connection           # 测试连接
DELETE /api/cluster/:clusterTag/hyperpod      # 删除HyperPod


### 2️⃣ 集群依赖配置 (Dependencies)

POST   /api/cluster/configure-dependencies    # 配置依赖
GET    /api/cluster/:clusterTag/dependencies/status  # 依赖状态
POST   /api/cluster/reconfigure-dependencies/:clusterTag  # 重新配置


### 3️⃣ 节点组管理 (Node Groups)

POST   /api/cluster/create-nodegroup          # 创建节点组
DELETE /api/cluster/nodegroup/:nodeGroupName  # 删除节点组
PUT    /api/cluster/nodegroups/:name/scale    # 扩缩容节点组
PUT    /api/cluster/hyperpod/instances/:name/scale  # HyperPod扩缩容
POST   /api/cluster/hyperpod/add-instance-group     # 添加实例组
POST   /api/cluster/hyperpod/delete-instance-group  # 删除实例组


### 4️⃣ Karpenter 自动扩缩容

POST   /api/cluster/karpenter/install         # 安装Karpenter
GET    /api/cluster/karpenter/status          # Karpenter状态
DELETE /api/cluster/karpenter/uninstall       # 卸载Karpenter
GET    /api/cluster/karpenter/resources       # 资源列表
POST   /api/cluster/karpenter/unified-resources  # 创建NodeClass+NodePool
DELETE /api/cluster/karpenter/nodepool/:name  # 删除NodePool
GET    /api/cluster/karpenter/nodes           # Karpenter节点列表


### 5️⃣ 模型推理 (Inference)

POST   /api/deploy                            # 部署推理服务
POST   /api/deploy-service                    # 部署Service
POST   /api/deploy-advanced-scaling           # 部署SGLang Router
DELETE /api/delete-service/:serviceName       # 删除服务
POST   /api/scale-deployment                  # 扩缩容部署
POST   /api/test-model                        # 测试模型
GET    /api/deployments                       # 部署列表
GET    /api/sglang-deployments                # SGLang部署列表
GET    /api/routers                           # Router列表
DELETE /api/routers/:deploymentName           # 删除Router


### 6️⃣ 训练作业 (Training)

POST   /api/launch-training                   # 启动LlamaFactory训练
POST   /api/launch-torch-training             # 启动PyTorch训练
POST   /api/launch-verl-training              # 启动VERL训练
POST   /api/launch-script-training            # 启动脚本训练
POST   /api/launch-msswift-training           # 启动MSSwift训练
POST   /api/launch-sagemaker-job              # 启动SageMaker作业
GET    /api/training-jobs                     # 训练作业列表
GET    /api/hyperpod-jobs                     # HyperPod作业列表
DELETE /api/hyperpod-jobs/:jobName            # 删除训练作业
GET    /api/rayjobs                           # RayJob列表
DELETE /api/rayjobs/:jobName                  # 删除RayJob


### 7️⃣ MLflow 集成

POST   /api/configure-mlflow-auth             # 配置MLflow认证
POST   /api/create-mlflow-tracking-server     # 创建Tracking Server
GET    /api/training-history                  # 训练历史
POST   /api/mlflow-sync                       # MLflow同步
GET    /api/mlflow-metric-config              # 指标配置
POST   /api/mlflow-metric-config              # 保存指标配置


### 8️⃣ KEDA 扩缩容

POST   /api/deploy-keda-scaling               # 部署KEDA扩缩容
POST   /api/deploy-keda-scaling-unified       # 统一KEDA扩缩容
POST   /api/keda/preview                      # 预览配置
GET    /api/keda/status                       # KEDA状态
DELETE /api/keda/scaledobject/:name           # 删除ScaledObject


### 9️⃣ 模型下载与存储

POST   /api/download-model                    # 下载模型
POST   /api/download-model-enhanced           # 增强下载
GET    /api/s3-storages                       # S3存储列表
POST   /api/s3-storages                       # 添加S3存储
DELETE /api/s3-storages/:name                 # 删除S3存储
GET    /api/s3-storage-defaults               # 默认存储配置


### 🔟 日志与监控

GET    /api/logs/:jobName/:podName            # 获取日志
GET    /api/logs/:jobName/:podName/download   # 下载日志
GET    /api/hyperpod-jobs/:jobName/pods       # 作业Pod列表
GET    /api/rayjobs/:jobName/pods             # RayJob Pod列表


### 1️⃣1️⃣ 多集群管理

GET    /api/multi-cluster/list                # 集群列表
POST   /api/multi-cluster/switch              # 切换集群
POST   /api/multi-cluster/switch-kubectl      # 切换kubectl配置


### 1️⃣2️⃣ AWS 资源查询

GET    /api/aws/current-region                # 当前区域
GET    /api/aws/instance-types                # 实例类型列表
POST   /api/aws/instance-types/refresh        # 刷新实例类型
POST   /api/aws/instance-types/by-subnet      # 按子网查询实例


### 1️⃣3️⃣ 配置管理

POST   /api/llamafactory-config/save          # 保存LlamaFactory配置
GET    /api/llamafactory-config/load          # 加载配置
POST   /api/torch-config/save                 # 保存Torch配置
GET    /api/torch-config/load                 # 加载配置
POST   /api/verl-config/save                  # 保存VERL配置
GET    /api/verl-config/load                  # 加载配置
