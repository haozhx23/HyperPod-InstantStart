#!/bin/bash

echo "Installing dependencies..."
echo "SMHP TRAINING OP NPROC_PER_NODE: ${NPROC_PER_NODE}"
echo "SMHP TRAINING OP NNODES: ${NNODES}"

DOCKER_WORKDIR=/docker_workspace

cd $DOCKER_WORKDIR
cp -r ${MSSWIFT_RECIPE_RUN_PATH%/}/* ./
# cp -r /s3/train-recipes/ms-swift-project/* ./

# recipe 自带 ms-swift 源码时按原方式安装；镜像已装 3.11.1 时跳过（Dockerfile.torch 已安装，且 v3.11.1
# 的 setup.py 在 Python 3.13 上无法 `pip install -e`：exec 写入 locals() 读版本号，3.13 起不再生效）
if [ -d "ms-swift" ]; then
    (cd ms-swift/ && pip install -e .)
elif python -c "import sys, swift; sys.exit(swift.__version__ != '3.11.1')" 2>/dev/null; then
    echo "ms-swift 3.11.1 already installed in the image, skipping source install"
else
    echo "ms-swift directory not found, cloning from GitHub..."
    git clone -b v3.11.1 https://github.com/modelscope/ms-swift.git
    (cd ms-swift/ && pip install -e .)
fi

SERVER_LOG_LEVEL=${SERVER_LOG_LEVEL:-info}
    # --post-train-script=$DOCKER_WORKDIR/post_train.sh \
# sleep 3000
hyperpodrun \
    --nnodes=${NNODES} --nproc-per-node=${NPROC_PER_NODE} \
    --server-host=0.0.0.0 --server-port=8080 \
    --server-log-level=${SERVER_LOG_LEVEL} \
    --tee=3 --log_dir=/tmp/hyperpod \
        -m $MSSWIFT_COMMAND_TYPE \
        $MSSWIFT_RECIPE_YAML_FILE
