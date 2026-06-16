#!/bin/bash
# Build the agentic-rl veRL image and push to your private ECR.
# Output image URI is what you paste into the RayJob panel's "Docker Image" field.
set -e

algorithm_name=hypd-agentic-verl
img_version=latest

region=$(aws configure get region)
account=$(aws sts get-caller-identity --query Account --output text)

# Login to private ECR + the AWS DLC base-image registry.
aws ecr get-login-password --region "${region}" | docker login --username AWS --password-stdin "${account}.dkr.ecr.${region}.amazonaws.com"
aws ecr get-login-password --region "${region}" | docker login --username AWS --password-stdin "763104351884.dkr.ecr.${region}.amazonaws.com"

aws ecr describe-repositories --region "$region" --repository-names "${algorithm_name}" >/dev/null 2>&1 || {
    echo "create repository: ${algorithm_name}"
    aws ecr create-repository --region "$region" --repository-name "${algorithm_name}" >/dev/null
}

docker build -t "${algorithm_name}" -f Dockerfile .

fullname="${account}.dkr.ecr.${region}.amazonaws.com/${algorithm_name}:${img_version}"
docker tag "${algorithm_name}" "${fullname}"
docker push "${fullname}"

echo "Successfully pushed: $fullname"
