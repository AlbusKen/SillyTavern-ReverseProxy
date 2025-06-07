@echo off
echo Finding and killing process on port 8889...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8889 ^| findstr LISTENING') do (
    if not "%%a" == "" (
        echo Found process with PID: %%a
        taskkill /F /PID %%a
    )
)
echo Done.
