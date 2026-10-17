@echo off
rem Copy this file to start.local.bat and edit your local paths.
rem start.local.bat is excluded from Git.
set "LLAMA_DIR=C:\path\to\llama.cpp"
set "MODEL=C:\path\to\models\your-model.gguf"
rem 12K leaves room for long replies while fitting a 12GB GPU more safely than 16K.
set "LLAMA_CTX=12288"
