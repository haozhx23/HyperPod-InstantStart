#!/bin/bash

# Model Deployment UI 启动脚本

# 端口配置 - 可通过环境变量或命令行参数覆盖
LOCAL_FORWARD_PORT=${1:-${LOCAL_FORWARD_PORT:-3099}}

if [ ! -f ".venv/" ]; then
    ./_setup.sh
fi

echo "🚀 Starting Model Deployment Management Dashboard..."
echo "🔧 Using local forward port: $LOCAL_FORWARD_PORT"

# 检查Node.js版本
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Node.js version $NODE_VERSION is too old. Please upgrade to Node.js 16+."
    exit 1
fi

# 检查kubectl
# if ! command -v kubectl &> /dev/null; then
#     echo "❌ kubectl is not installed or not in PATH."
#     exit 1
# fi

# # 测试kubectl连接
# echo "🔍 Testing kubectl connection..."
# if ! kubectl cluster-info &> /dev/null; then
#     echo "❌ kubectl is not properly configured or cluster is not accessible."
#     echo "Please run: kubectl cluster-info"
#     exit 1
# fi

echo "✅ kubectl connection successful"

# 激活 Python 环境 (用于 MLflow)
echo "🐍 Activating Python environment..."
if [ -d ".venv" ]; then
    source .venv/bin/activate
    echo "✅ Python environment activated: $(python --version)"
    
    # 验证 MLflow 可用性
    if python -c "import mlflow" 2>/dev/null; then
        echo "✅ MLflow available: $(python -c 'import mlflow; print(mlflow.__version__)')"
    else
        echo "⚠️  MLflow not available, Training History may not work"
    fi
else
    echo "⚠️  Python environment not found. Run ./setup.sh first"
    echo "   Training History features will not work without Python environment"
fi

# 清理可能占用端口的进程
echo "🧹 Cleaning up existing processes..."

# 清理相关的Node.js进程
pkill -f "node server/index.js" 2>/dev/null || true
pkill -f "react-scripts start" 2>/dev/null || true
pkill -f "concurrently" 2>/dev/null || true
pkill -f "nodemon server/index.js" 2>/dev/null || true

# 等待进程完全退出
sleep 3

# 检查并清理占用关键端口的进程
echo "🔍 Checking port usage..."

# 检查端口3099 (前端 - 现在直接监听公网)
if lsof -ti :3099 >/dev/null 2>&1; then
    echo "⚠️  Port 3099 is occupied, killing processes..."
    lsof -ti :3099 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 检查端口3001 (后端API)
if lsof -ti :3001 >/dev/null 2>&1; then
    echo "⚠️  Port 3001 is occupied, killing processes..."
    lsof -ti :3001 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 检查端口8081 (WebSocket)
if lsof -ti :8081 >/dev/null 2>&1; then
    echo "⚠️  Port 8081 is occupied, killing processes..."
    lsof -ti :8081 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 最终确认端口状态
PORTS_CLEAR=true
for port in 3099 3001 8081; do
    if lsof -ti :$port >/dev/null 2>&1; then
        echo "❌ Port $port is still occupied"
        PORTS_CLEAR=false
    fi
done

if [ "$PORTS_CLEAR" = true ]; then
    echo "✅ All required ports (3099, 3001, 8081) are now available"
else
    echo "⚠️  Some ports are still occupied, but continuing..."
fi

# 获取公网IP用于显示访问地址
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)
PUBLIC_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null)

if [ -n "$PUBLIC_IP" ]; then
    echo "🌐 Application will be accessible at: http://$PUBLIC_IP:$LOCAL_FORWARD_PORT"
else
    echo "🌐 Application will be accessible at: http://localhost:$LOCAL_FORWARD_PORT"
fi

# 检查依赖是否已安装
if [ ! -d "node_modules" ] || [ ! -d "client/node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm run install-all
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
fi

# 创建日志目录
mkdir -p logs

# 快速测试API
echo "🧪 Quick API test..."
node server/index.js &
SERVER_PID=$!
sleep 3

# 测试API是否响应
if curl -s http://localhost:3001/api/services > /dev/null; then
    SERVICES_COUNT=$(curl -s http://localhost:3001/api/services | jq '. | length' 2>/dev/null || echo "0")
    echo "✅ Backend API working: $SERVICES_COUNT services detected"
else
    echo "⚠️  Backend API test failed, but continuing..."
fi

# 停止测试服务器
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
sleep 1

echo "🌟 Starting services..."
if [ -n "$PUBLIC_IP" ]; then
    echo "📊 Dashboard will be available at: http://$PUBLIC_IP:$LOCAL_FORWARD_PORT"
else
    echo "📊 Dashboard will be available at: http://localhost:$LOCAL_FORWARD_PORT"
fi
echo "🔌 API server will run on: http://localhost:3001"
echo "🔄 WebSocket server will run on: ws://localhost:8081"
echo ""
echo "Press Ctrl+C to stop all services"
echo "----------------------------------------"

# 启动开发服务器
npm run dev
