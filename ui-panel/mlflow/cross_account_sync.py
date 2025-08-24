#!/usr/bin/env python3
"""
MLflow Cross-Account Experiment Sync Tool
=========================================

Usage:
    python cross_account_sync.py --config-file config.json --experiment-name hz-torchrecipe-1
"""

import mlflow
import mlflow.tracking
import boto3
import argparse
import os
import sys
import json
from datetime import datetime

def load_config(config_file):
    """加载配置文件"""
    with open(config_file, 'r') as f:
        return json.load(f)

def assume_role(role_arn):
    """假设跨账户角色"""
    sts = boto3.client('sts')
    response = sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName=f'cross-acct-mlflow-sync-{datetime.now().strftime("%Y%m%d%H%M%S")}',
        DurationSeconds=3600
    )
    
    creds = response['Credentials']
    os.environ['AWS_ACCESS_KEY_ID'] = creds['AccessKeyId']
    os.environ['AWS_SECRET_ACCESS_KEY'] = creds['SecretAccessKey']
    os.environ['AWS_SESSION_TOKEN'] = creds['SessionToken']

def get_experiment_by_name_or_id(client, experiment_identifier):
    """通过名称或ID获取实验"""
    try:
        # 首先尝试作为名称获取
        return client.get_experiment_by_name(experiment_identifier)
    except:
        try:
            # 如果失败，尝试作为ID获取
            return client.get_experiment(experiment_identifier)
        except:
            raise Exception(f"Experiment '{experiment_identifier}' not found (tried both name and ID)")

def sync_experiment(config, experiment_identifier):
    """同步实验"""
    # 直接使用配置中的ARNs
    source_arn = config['source_mlflow_arn']
    target_arn = config['shared_mlflow_arn']
    contributor_tag = config['contributor_name']
    
    print(f"Source MLflow: {source_arn}")
    print(f"Target MLflow: {target_arn}")
    print(f"Experiment identifier: {experiment_identifier}")
    
    # 创建客户端 - 使用环境变量方式避免 ARN 解析问题
    import os
    
    # 保存当前环境变量
    original_uri = os.environ.get('MLFLOW_TRACKING_URI', '')
    
    try:
        # 设置源 MLflow URI 并创建客户端
        os.environ['MLFLOW_TRACKING_URI'] = source_arn
        source_client = mlflow.tracking.MlflowClient()
        
        # 获取源实验（支持名称或ID）
        source_exp = get_experiment_by_name_or_id(source_client, experiment_identifier)
        print(f"Found source experiment: {source_exp.name} (ID: {source_exp.experiment_id})")
        
        # 设置目标 MLflow URI 并创建客户端
        os.environ['MLFLOW_TRACKING_URI'] = target_arn
        target_client = mlflow.tracking.MlflowClient()
        
        target_exp_name = f"{source_exp.name}_{contributor_tag}"
        
        # 创建或获取目标实验
        try:
            target_exp = target_client.get_experiment_by_name(target_exp_name)
            # 检查实验是否被删除
            if target_exp.lifecycle_stage == 'deleted':
                print(f"Target experiment {target_exp_name} was deleted, restoring it...")
                # 恢复已删除的实验
                target_client.restore_experiment(target_exp.experiment_id)
                target_exp_id = target_exp.experiment_id
                print(f"Restored target experiment: {target_exp_name} (ID: {target_exp_id})")
            else:
                target_exp_id = target_exp.experiment_id
                print(f"Target experiment already exists: {target_exp_name} (ID: {target_exp_id})")
        except:
            target_exp_id = target_client.create_experiment(
                name=target_exp_name,
                tags={
                    'source_experiment_id': source_exp.experiment_id,
                    'source_experiment_name': source_exp.name,
                    'contributor_tag': contributor_tag,
                    'sync_timestamp': datetime.now().isoformat()
                }
            )
            print(f"Created target experiment: {target_exp_name} (ID: {target_exp_id})")
        
        # 切换回源 MLflow 来获取 runs
        os.environ['MLFLOW_TRACKING_URI'] = source_arn
        source_client = mlflow.tracking.MlflowClient()
        
        # 同步runs
        runs = source_client.search_runs(experiment_ids=[source_exp.experiment_id])
        print(f"Syncing {len(runs)} runs...")
        
        # 切换到目标 MLflow 进行同步
        os.environ['MLFLOW_TRACKING_URI'] = target_arn
        target_client = mlflow.tracking.MlflowClient()
        
        synced_count = 0
        for run in runs:
            # 检查是否已经同步过这个run
            existing_runs = target_client.search_runs(
                experiment_ids=[target_exp_id],
                filter_string=f"tags.source_run_id = '{run.info.run_id}'"
            )
            
            if existing_runs:
                print(f"  Skipping run {run.info.run_id} (already synced)")
                continue
                
            with mlflow.start_run(experiment_id=target_exp_id) as target_run:
                # 同步参数
                for key, value in run.data.params.items():
                    target_client.log_param(target_run.info.run_id, key, value)
                
                # 同步指标
                for key, value in run.data.metrics.items():
                    target_client.log_metric(target_run.info.run_id, key, value)
                
                # 同步标签
                tags = run.data.tags.copy() if run.data.tags else {}
                tags.update({
                    'source_run_id': run.info.run_id,  # 保留用于重复检测
                    'contributor_tag': contributor_tag,
                    'sync_timestamp': datetime.now().isoformat()
                })
                
                for key, value in tags.items():
                    target_client.set_tag(target_run.info.run_id, key, value)
                
                synced_count += 1
                print(f"  ✓ Synced run {run.info.run_id}")
        
        print(f"✅ Synced experiment '{source_exp.name}' -> '{target_exp_name}' ({synced_count} new runs)")
        
    finally:
        # 恢复原始环境变量
        if original_uri:
            os.environ['MLFLOW_TRACKING_URI'] = original_uri
        elif 'MLFLOW_TRACKING_URI' in os.environ:
            del os.environ['MLFLOW_TRACKING_URI']

def main():
    parser = argparse.ArgumentParser(description='Sync MLflow experiment')
    parser.add_argument('--config-file', required=True, help='Configuration file')
    
    # 支持两种参数格式以保持兼容性
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--experiment-id', help='Experiment ID to sync (for backward compatibility)')
    group.add_argument('--experiment-name', help='Experiment name to sync')
    
    args = parser.parse_args()
    
    # 确定使用哪个标识符
    experiment_identifier = args.experiment_name if args.experiment_name else args.experiment_id
    
    try:
        # 加载配置
        config = load_config(args.config_file)
        print(f"Loaded config for contributor: {config['contributor_name']}")
        
        # 检查是否需要跨账户访问
        # 注意：即使在同一账户内，也可能需要 assume role 来获得特定权限
        if 'cross_account_role_arn' in config and config['cross_account_role_arn']:
            print("Assuming cross-account role for permissions...")
            assume_role(config['cross_account_role_arn'])
        else:
            print("No cross-account role specified, using current credentials")
        
        # 同步实验
        sync_experiment(config, experiment_identifier)
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
