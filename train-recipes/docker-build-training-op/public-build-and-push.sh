#!/bin/bash

# 设置错误时退出
set -e

algorithm_name=hypd-training-op-torch26-pub
docker_filename=Dockerfile.torch
# algorithm_name=hypd-training-op-torch26-msswift-put
# docker_filename=Dockerfile.ms-swift

img_version=v0110

region=$(aws configure get region)
account=$(aws sts get-caller-identity --query Account --output text)

# 获取 ECR Public 别名
registry_alias=$(aws ecr-public describe-registries --region us-east-1 --query 'registries[0].aliases[0].name' --output text)

echo "Building in region: $region"
echo "Account: $account"
echo "Registry alias: $registry_alias"
echo "Algorithm name: $algorithm_name"

# 登录到私有 ECR
echo "Logging into private ECR..."
aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin "${account}.dkr.ecr.${region}.amazonaws.com"
aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin "763104351884.dkr.ecr.${region}.amazonaws.com"

# 登录到 ECR Public (必须使用 us-east-1)
echo "Logging into ECR Public..."
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws

# 检查 ECR Public 仓库是否存在
echo "Checking if ECR Public repository exists..."
if ! aws ecr-public describe-repositories --region us-east-1 --repository-names "${algorithm_name}" > /dev/null 2>&1; then
    echo "Creating ECR Public repository: ${algorithm_name}"
    aws ecr-public create-repository --region us-east-1 --repository-name "${algorithm_name}"
else
    echo "ECR Public repository ${algorithm_name} already exists"
fi

# 构建 Docker 镜像
echo "Building Docker image..."
docker build -t ${algorithm_name} -f ${docker_filename} .

# 推送到 ECR Public
fullname="public.ecr.aws/${registry_alias}/${algorithm_name}:${img_version}"
echo "Tagging image as: $fullname"
docker tag ${algorithm_name} ${fullname}

echo "Pushing to ECR Public..."
docker push ${fullname}

echo "Successfully pushed: $fullname"
