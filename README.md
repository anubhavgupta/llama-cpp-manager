# LLAMA CPP Manager
Tool to manage LLAMA.CPP model configurations.

<img width="1039" height="905" alt="image" src="https://github.com/user-attachments/assets/6c97b689-6cb1-4d07-97f1-a30670385dae" />

# Features
- Load / Unload a model
- Store multiple model configurations.
- PWA, can be installed as a desktop app.
- Monitor usage of CPU, GPU, RAM and VRAM

## Important
- Model Discovery: Model location is currently hardcoded in server.js file, this needs to be updated to the location where you store your models.

## Getting Started
1. Install dependencies: `npm install`
2. Create .env file in root directory
    - Create variable:- MODEL_PATH=D:\.lmstudio\models
    - Here you can give your models path. Example: - D:\.lmstudio\models
3. Start the server: `node run start`
4. Open browser to `http://localhost:3001`

# PS:
This tool was vibecoded using QWEN3-30B-A3B_2507_Q4 model.
