
# mkdir data models checkpoints
mkdir -p data
python verl/examples/data_preprocess/gsm8k.py --local_save_dir data/gsm8k
# huggingface-cli download Qwen/Qwen2.5-3B-Instruct --local-dir models/Qwen/Qwen2.5-3B-Instruct --local-dir-use-symlinks False
# huggingface-cli download Qwen/Qwen2.5-0.5B-Instruct --local-dir models/Qwen/Qwen2.5-0.5B-Instruct --local-dir-use-symlinks False
