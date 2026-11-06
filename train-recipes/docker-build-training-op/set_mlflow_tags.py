#!/usr/bin/env python3
"""
在训练开始前设置MLflow tags的脚本
"""
import mlflow
import os
import sys
import json
from pathlib import Path

def set_infrastructure_tags():
    """设置基础设施相关的MLflow tags"""
    
    # 设置tracking URI
    tracking_uri = os.getenv("MLFLOW_TRACKING_URI")
    if not tracking_uri:
        print("MLFLOW_TRACKING_URI is not set; infrastructure tagging is disabled.", file=sys.stderr)
        return
    mlflow.set_tracking_uri(tracking_uri)
    
    # experiment_name = "test-model-1-20250815_101449"
    # run_name = "run-name-1-20250815_101449"

    experiment_name = os.getenv("MLFLOW_EXPERIMENT_NAME")
    # run_name = os.getenv("MLFLOW_RUN_NAME")

    infra_info = {
            "instance_type": os.getenv("MLFLOW_TAG_INSTANCETYPE"),
            "replica_count": os.getenv("MLFLOW_TAG_REPLICAS"),
            "proc_per_node": os.getenv("MLFLOW_TAG_NPROCPERNODE"),
        }


    # if Path('lmf_conf_tags.json').exists():
    #     with open('lmf_conf_tags.json', 'r') as f:
    #         mlflow_lmf_tag_envs = json.load(f)
        
    #     run_name = mlflow_lmf_tag_envs['MLFLOW_RUN']

    #     print(f"Setting up MLflow tags for experiment: {experiment_name}, run: {run_name}")

    #     # 基础设施信息
    #     lfm_info = {
    #         "model": mlflow_lmf_tag_envs['LMF_MODEL'],
    #         "dataset": mlflow_lmf_tag_envs['LMF_DATASET'],
    #         "cutoff_len": mlflow_lmf_tag_envs['LMF_CUTOFF'],
    #         "deepspeed_conf": mlflow_lmf_tag_envs['LMF_DSCONF'],
    #         # "micro_batchsize": mlflow_lmf_tag_envs['LMF_MBS'],
    #         "batch_size": mlflow_lmf_tag_envs['LMF_MBS'] * int(os.getenv("MLFLOW_TAG_REPLICAS")) * int(os.getenv("MLFLOW_TAG_NPROCPERNODE"))
    #     }
    #     infra_info.update(lfm_info)
    
    if Path('mlflow-tags.json').exists():
        with open('mlflow-tags.json', 'r') as f:
            mlflow_metric_tags = json.load(f)

        run_name = mlflow_metric_tags['MLFLOW_RUN']

        gen_info = {
            "model": mlflow_metric_tags['MODEL'],
            "dataset": mlflow_metric_tags['DATASET'],
            "cutoff_len": mlflow_metric_tags['CUTOFF'],
            "deepspeed_conf": mlflow_metric_tags['ZEROCONF'],
            # "micro_batchsize": mlflow_lmf_tag_envs['LMF_MBS'],
            "batch_size": mlflow_metric_tags['MBS'] * int(mlflow_metric_tags['ACCUM']) * int(os.getenv("MLFLOW_TAG_REPLICAS")) * int(os.getenv("MLFLOW_TAG_NPROCPERNODE"))
        }
        
        infra_info.update(gen_info)
    else:
        pass
    
    # 通过experiment_name和run_name查找已存在的run
    client = mlflow.tracking.MlflowClient()
    experiment = mlflow.get_experiment_by_name(experiment_name)
    
    if not experiment:
        print(f"Experiment '{experiment_name}' not found!")
        return
    
    # 搜索指定experiment中的runs
    runs = client.search_runs(
        experiment_ids=[experiment.experiment_id],
        filter_string=f"tags.mlflow.runName = '{run_name}'"
    )
    
    if runs:
        existing_run = runs[0]  # 取第一个匹配的run
        print(f"Found existing run: {existing_run.info.run_id} with name: {run_name}")
        
        # 在已存在的run上设置tags
        with mlflow.start_run(run_id=existing_run.info.run_id):
            for key, value in infra_info.items():
                mlflow.set_tag(key, value)
                print(f"Set tag: {key} = {value}")
    else:
        print(f"No existing run found with name: {run_name} in experiment: {experiment_name}")
        print("Available runs in this experiment:")
        all_runs = client.search_runs(experiment_ids=[experiment.experiment_id])
        for run in all_runs:
            run_name_tag = run.data.tags.get("mlflow.runName", "No name")
            print(f"  Run ID: {run.info.run_id}, Name: {run_name_tag}")
        return
    
    print("Infrastructure tags set successfully on existing run!")



if __name__ == "__main__":
    try:
        set_infrastructure_tags()
    except Exception as e:
        print(f"Error setting MLflow tags: {e}")
    
    sys.exit(0)