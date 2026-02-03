# LLAMA CPP Manager
Tool to manage LLAMA.CPP model configurations.

<img width="1703" height="1401" alt="image" src="https://github.com/user-attachments/assets/d686a19b-d1e5-4c5c-a7c3-fc3d09ff097a" />

# How to use
- Click on Setting button to open the settings dialog box and set the model directory path: 
<img width="476" height="314" alt="image" src="https://github.com/user-attachments/assets/11a20ac9-a992-4740-b7a8-9409564f1058" />

<img width="707" height="515" alt="image" src="https://github.com/user-attachments/assets/30705b1c-dadb-453b-a374-79868bd03a12" />

- Click on Add button to add a new configuration for a model, clicking on Launch would auto save the model settings.
<img width="503" height="179" alt="image" src="https://github.com/user-attachments/assets/6fd0561c-386e-401a-93c5-bc20d3442cc1" />
<img width="1149" height="158" alt="image" src="https://github.com/user-attachments/assets/51b7fcc5-5479-46ad-8ad0-d09e67f15940" />

- Once you have added a bunch of configs, you can use presets feature of llama.cpp which lets you load and unload models from the llama.cpp interface itself. 
<img width="1025" height="273" alt="image" src="https://github.com/user-attachments/assets/768bea42-a419-47f9-8284-acaf7a100f2b" />



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
