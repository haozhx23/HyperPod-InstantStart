#!/bin/bash

# Model Deployment UI - 快速安装脚本
# 整合了 install.sh 和 setup-environment.sh 的核心功能

echo "🔧 Model Deployment Management Dashboard - Quick Setup"
echo "======================================================"

# 检查项目根目录
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script in the project root directory."
    exit 1
fi

# 检查并安装Node.js
if ! command -v node &> /dev/null; then
    echo "📥 Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 检查npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not available after Node.js installation"
    exit 1
fi

echo "✅ Node.js $(node -v) and npm $(npm -v) are ready"

# 检查kubectl (可选)
if command -v kubectl &> /dev/null; then
    echo "✅ kubectl is available"
else
    echo "⚠️  kubectl not found (optional for local development)"
fi

# 安装项目依赖
echo "📦 Installing project dependencies..."
npm install

echo "📦 Installing client dependencies..."
cd client && npm install && cd ..

# 创建必要目录和文件
mkdir -p logs tmp
chmod +x *.sh 2>/dev/null || true

# 创建.env文件（如果不存在）
if [ ! -f ".env" ]; then
    cat > .env << 'EOF'
# Model Deployment UI Configuration
PORT=3001
WS_PORT=8081
NODE_ENV=development
EOF
    echo "📝 Created .env file"
fi

echo ""
echo "🎉 Setup completed successfully!"
echo ""
echo "🚀 To start the application:"
echo "   ./start.sh"
echo ""
echo "📊 Dashboard will be available at: http://localhost:3000"
