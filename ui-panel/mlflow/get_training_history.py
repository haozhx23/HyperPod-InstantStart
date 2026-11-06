#!/usr/bin/env python3
"""
获取 MLflow 训练历史数据，用于Training History页面
"""


import os
import sys
import json
import mlflow
import pandas as pd
from datetime import datetime
import traceback

def get_training_history(tracking_uri=None):
    """获取训练历史数据"""
    try:
        # MLflow tracking server URI - 从命令行参数或环境变量获取
        if tracking_uri is None:
            tracking_uri = os.environ.get("MLFLOW_TRACKING_URI")
        if not tracking_uri:
            raise ValueError("Configure a tracking server ARN or set MLFLOW_TRACKING_URI.")
        
        print(f"🔍 连接到 MLflow: {tracking_uri}", file=sys.stderr)
        mlflow.set_tracking_uri(tracking_uri)
        
        # 获取所有实验
        experiments = mlflow.search_experiments()
        print(f"📊 找到 {len(experiments)} 个实验", file=sys.stderr)
        
        # 收集所有训练历史数据
        training_history = []
        
        for exp in experiments:
            try:
                # 获取实验的所有runs
                runs = mlflow.search_runs(experiment_ids=[exp.experiment_id])
                
                if runs.empty:
                    continue
                
                # 提取metrics列
                metric_columns = [col for col in runs.columns if col.startswith('metrics.')]
                param_columns = [col for col in runs.columns if col.startswith('params.')]
                
                # 处理每个run
                for _, run in runs.iterrows():
                    run_data = {
                        'experiment_name': exp.name,
                        'experiment_id': exp.experiment_id,
                        'run_id': run['run_id'],
                        'run_name': run.get('tags.mlflow.runName', 'N/A'),
                        'status': run['status'],
                        'start_time': run['start_time'].isoformat() if pd.notna(run['start_time']) else None,
                        'end_time': run['end_time'].isoformat() if pd.notna(run['end_time']) else None,
                        'duration': None,
                        'metrics': {},
                        'params': {},
                        'tags': {}
                    }
                    
                    # 计算训练时长
                    if pd.notna(run['start_time']) and pd.notna(run['end_time']):
                        duration = run['end_time'] - run['start_time']
                        run_data['duration'] = str(duration)
                    
                    # 添加metrics
                    for metric_col in metric_columns:
                        metric_name = metric_col.replace('metrics.', '')
                        metric_value = run[metric_col]
                        if pd.notna(metric_value):
                            run_data['metrics'][metric_name] = float(metric_value)
                    
                    # 添加params
                    for param_col in param_columns:
                        param_name = param_col.replace('params.', '')
                        param_value = run[param_col]
                        if pd.notna(param_value):
                            run_data['params'][param_name] = str(param_value)
                    
                    # 添加tags
                    tag_columns = [col for col in runs.columns if col.startswith('tags.')]
                    for tag_col in tag_columns:
                        tag_name = tag_col.replace('tags.', '')
                        tag_value = run[tag_col]
                        if pd.notna(tag_value):
                            run_data['tags'][tag_name] = str(tag_value)
                    
                    training_history.append(run_data)
                    
            except Exception as e:
                print(f"❌ 处理实验 {exp.name} 时出错: {str(e)}", file=sys.stderr)
                continue
        
        # 按开始时间倒序排列
        training_history.sort(key=lambda x: x['start_time'] or '', reverse=True)
        
        print(f"✅ 成功获取 {len(training_history)} 条训练记录", file=sys.stderr)
        
        # 输出JSON格式的结果
        return {
            'success': True,
            'data': training_history,
            'total': len(training_history)
        }
        
    except Exception as e:
        error_msg = f"获取训练历史失败: {str(e)}"
        print(f"❌ {error_msg}", file=sys.stderr)
        print(f"详细错误: {traceback.format_exc()}", file=sys.stderr)
        return {
            'success': False,
            'error': error_msg,
            'data': []
        }

if __name__ == "__main__":
    # 从命令行参数获取tracking URI
    tracking_uri = None
    if len(sys.argv) > 1:
        tracking_uri = sys.argv[1]
        print(f"🔧 使用命令行参数指定的 MLflow URI: {tracking_uri}", file=sys.stderr)
    
    result = get_training_history(tracking_uri)
    print(json.dumps(result, indent=2, ensure_ascii=False))
