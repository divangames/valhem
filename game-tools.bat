@echo off
rem Запуск игры, отправка изменений и обновление GitHub Pages из папки батника.
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1
title VALHEM - управление проектом

set "REPO_URL=https://github.com/divangames/valhem.git"
set "PAGES_URL=https://divangames.github.io/valhem/"
set "VPS_HOST=213.139.209.107"
set "VPS_USER=root"
set "VPS_KEY=%USERPROFILE%\.ssh\valhem_deploy_ed25519"
set "VPS_HEALTH_URL=https://213.139.209.107/api/health"
if /i "%~1"=="--check" goto check_only
if /i "%~1"=="--deploy-vps" goto deploy_vps_cli
if /i "%~1"=="--deploy-all" goto deploy_all_cli

:menu
cls
echo ==============================================
echo        VALHEM - управление проектом
echo ==============================================
echo.
echo  [1] Запустить игру
echo  [2] Commit + push на GitHub
echo  [3] Полный деплой: GitHub Pages + VPS
echo  [4] Обновить только GitHub Pages
echo  [5] Обновить только сервер VPS
echo  [6] Открыть страницу игры
echo  [0] Выход
echo.
choice /c 1234560 /n /m "Выберите действие: "
if errorlevel 7 goto :eof
if errorlevel 6 goto open_pages
if errorlevel 5 goto update_vps
if errorlevel 4 goto update_pages
if errorlevel 3 goto deploy_all
if errorlevel 2 goto publish
if errorlevel 1 goto launch
goto menu

:launch
cls
echo Запуск игры...

if exist "package.json" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ОШИБКА] npm не найден. Установите Node.js и повторите запуск.
    goto pause_menu
  )

  if not exist "node_modules" (
    echo Устанавливаю зависимости...
    call npm install
    if errorlevel 1 goto command_failed
  )

  node -e "const p=require('./package.json');process.exit(p.scripts?.dev?0:1)" >nul 2>nul
  if not errorlevel 1 (
    start "LIFE TO LIVE" cmd /k "npm run dev"
    goto menu
  )

  node -e "const p=require('./package.json');process.exit(p.scripts?.start?0:1)" >nul 2>nul
  if not errorlevel 1 (
    start "LIFE TO LIVE" cmd /k "npm start"
    goto menu
  )
)

if exist "index.html" (
  start "" "%CD%\index.html"
  goto menu
)

for %%F in (*.html) do (
  start "" "%%~fF"
  goto menu
)

for %%F in (*.exe) do (
  if /i not "%%~nxF"=="unins000.exe" (
    start "" "%%~fF"
    goto menu
  )
)

echo [ОШИБКА] Не найдена команда npm run dev/start, HTML-страница или EXE-файл.
goto pause_menu

:publish
cls
call :check_git || goto pause_menu
call :configure_remote || goto pause_menu
call :check_branch || goto pause_menu

set "COMMIT_MESSAGE="
set /p "COMMIT_MESSAGE=Сообщение коммита (Enter = Update game): "
if not defined COMMIT_MESSAGE set "COMMIT_MESSAGE=Update game"
rem Убираем кавычки из ввода, чтобы сообщение не нарушало синтаксис cmd.
set "COMMIT_MESSAGE=%COMMIT_MESSAGE:"=%"
if not defined COMMIT_MESSAGE set "COMMIT_MESSAGE=Update game"

rem .gitignore сам исключает back; отдельный pathspec игнорируемой папки вызывает ошибку Git.
git add -A -- .
if errorlevel 1 goto command_failed

git diff --cached --quiet
if errorlevel 2 goto command_failed
if errorlevel 1 (
  git commit -m "%COMMIT_MESSAGE%"
  if errorlevel 1 goto command_failed
) else (
  echo Изменений для нового коммита нет.
)

git push -u origin main
if errorlevel 1 goto command_failed

echo.
echo Готово: изменения отправлены в %REPO_URL%
goto pause_menu

:deploy_all
cls
echo Полный деплой VALHEM: GitHub Pages + сервер VPS.
call :check_git || goto pause_menu
call :configure_remote || goto pause_menu
call :check_branch || goto pause_menu
call :test_server || goto pause_menu
call :commit_and_push "Deploy VALHEM" 1 || goto pause_menu
call :deploy_vps || goto pause_menu
call :wait_pages || goto pause_menu
echo.
echo [OK] Полный деплой завершён: Pages и VPS обновлены и проверены.
echo %PAGES_URL%
start "" "%PAGES_URL%"
goto pause_menu

:update_pages
cls
echo Обновление GitHub Pages через GitHub Actions.
call :check_git || goto pause_menu
call :configure_remote || goto pause_menu
call :check_branch || goto pause_menu
call :commit_and_push "Update GitHub Pages" 1 || goto pause_menu
call :wait_pages || goto pause_menu
echo.
echo [OK] GitHub Pages успешно обновлён.
echo %PAGES_URL%
start "" "%PAGES_URL%"
goto pause_menu

:update_vps
cls
echo Обновление серверной части VALHEM на VPS.
call :test_server || goto pause_menu
call :deploy_vps || goto pause_menu
echo.
echo [OK] Сервер VPS успешно обновлён и отвечает на проверку.
goto pause_menu

:commit_and_push
set "AUTO_COMMIT_MESSAGE=%~1"
set "ALLOW_EMPTY=%~2"

rem .gitignore сам исключает back; отдельный pathspec игнорируемой папки вызывает ошибку Git.
git add -A -- .
if errorlevel 1 exit /b 1
git diff --cached --quiet
if errorlevel 2 exit /b 1
if errorlevel 1 (
  git commit -m "%AUTO_COMMIT_MESSAGE%"
  if errorlevel 1 exit /b 1
) else if "%ALLOW_EMPTY%"=="1" (
  rem Новый коммит запускает push-workflow даже при отсутствии изменений файлов.
  git commit --allow-empty -m "%AUTO_COMMIT_MESSAGE%"
  if errorlevel 1 exit /b 1
)

git push -u origin main
if errorlevel 1 exit /b 1
for /f "delims=" %%H in ('git rev-parse HEAD') do set "DEPLOY_SHA=%%H"
exit /b 0

:wait_pages
echo.
echo Ожидаю GitHub Actions для коммита %DEPLOY_SHA%...
where gh >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] GitHub CLI не найден. Невозможно подтвердить деплой Pages:
  echo https://github.com/divangames/valhem/actions
  exit /b 1
)
gh auth status >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] GitHub CLI не авторизован. Невозможно подтвердить деплой Pages:
  echo https://github.com/divangames/valhem/actions
  exit /b 1
)

set "PAGES_RUN_ID="
for /l %%N in (1,1,15) do (
  for /f "delims=" %%R in ('gh run list --repo divangames/valhem --workflow deploy-pages.yml --commit "%DEPLOY_SHA%" --limit 1 --json databaseId --jq ".[0].databaseId" 2^>nul') do set "PAGES_RUN_ID=%%R"
  if defined PAGES_RUN_ID goto pages_run_found
  timeout /t 2 /nobreak >nul
)
echo [ОШИБКА] Запуск GitHub Actions не появился за отведённое время:
echo https://github.com/divangames/valhem/actions
exit /b 1

:pages_run_found
gh run watch %PAGES_RUN_ID% --repo divangames/valhem --exit-status
if errorlevel 1 exit /b 1
curl.exe --fail --silent --show-error --max-time 20 "%PAGES_URL%" >nul
if errorlevel 1 exit /b 1
exit /b 0

:test_server
where npm >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] npm не найден. Установите Node.js для проверки сервера.
  exit /b 1
)
if not exist "server\package.json" (
  echo [ОШИБКА] Не найден server\package.json.
  exit /b 1
)
pushd "server"
if not exist "node_modules" (
  echo Устанавливаю зависимости сервера...
  call npm ci
  if errorlevel 1 (
    popd
    exit /b 1
  )
)
echo Проверяю серверную часть...
call npm test
set "SERVER_TEST_EXIT=%ERRORLEVEL%"
popd
if not "%SERVER_TEST_EXIT%"=="0" exit /b 1
exit /b 0

:deploy_vps
:check_vps_tools
where ssh >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] ssh не найден в PATH.
  exit /b 1
)
where scp >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] scp не найден в PATH.
  exit /b 1
)
where tar >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] tar не найден в PATH.
  exit /b 1
)
if not exist "%VPS_KEY%" (
  echo [ОШИБКА] Не найден SSH-ключ: %VPS_KEY%
  exit /b 1
)
if not exist "deploy\update-vps.sh" (
  echo [ОШИБКА] Не найден deploy\update-vps.sh.
  exit /b 1
)
if "%~1"=="--check-only" exit /b 0

set "DEPLOY_ID=%RANDOM%_%RANDOM%"
set "LOCAL_ARCHIVE=%TEMP%\valhem-server-%DEPLOY_ID%.tar.gz"
set "REMOTE_ARCHIVE=/tmp/valhem-server-%DEPLOY_ID%.tar.gz"
set "REMOTE_SCRIPT=/tmp/valhem-update-%DEPLOY_ID%.sh"

tar -czf "%LOCAL_ARCHIVE%" -C "server" package.json package-lock.json src test
if errorlevel 1 exit /b 1

echo Загружаю серверную сборку на VPS...
scp -i "%VPS_KEY%" -o StrictHostKeyChecking=accept-new "%LOCAL_ARCHIVE%" "%VPS_USER%@%VPS_HOST%:%REMOTE_ARCHIVE%"
if errorlevel 1 goto vps_deploy_failed
scp -i "%VPS_KEY%" -o StrictHostKeyChecking=accept-new "deploy\update-vps.sh" "%VPS_USER%@%VPS_HOST%:%REMOTE_SCRIPT%"
if errorlevel 1 goto vps_deploy_failed

ssh -i "%VPS_KEY%" -o StrictHostKeyChecking=accept-new "%VPS_USER%@%VPS_HOST%" "bash %REMOTE_SCRIPT% %REMOTE_ARCHIVE%"
if errorlevel 1 goto vps_deploy_failed

del /q "%LOCAL_ARCHIVE%" >nul 2>nul
curl.exe --fail --silent --show-error --max-time 20 "%VPS_HEALTH_URL%" >nul
if errorlevel 1 exit /b 1
exit /b 0

:vps_deploy_failed
del /q "%LOCAL_ARCHIVE%" >nul 2>nul
echo [ОШИБКА] Деплой VPS не завершён. Серверный скрипт выполнил откат, если замена уже началась.
exit /b 1

:open_pages
start "" "%PAGES_URL%"
goto menu

:check_git
where git >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Git не найден в PATH.
  exit /b 1
)
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Папка батника не является Git-репозиторием.
  exit /b 1
)
exit /b 0

:configure_remote
set "ACTUAL_REMOTE="
for /f "delims=" %%U in ('git remote get-url origin 2^>nul') do set "ACTUAL_REMOTE=%%U"
if not defined ACTUAL_REMOTE (
 git remote add origin "%REPO_URL%"
 if errorlevel 1 exit /b 1
 exit /b 0
)
if not "%ACTUAL_REMOTE%"=="%REPO_URL%" (
 echo [ОШИБКА] origin указывает на другой репозиторий. Проверьте git remote -v.
 exit /b 1
)
exit /b 0

:check_branch
set "ACTUAL_BRANCH="
for /f "delims=" %%B in ('git symbolic-ref --quiet --short HEAD') do set "ACTUAL_BRANCH=%%B"
if not "%ACTUAL_BRANCH%"=="main" (
  echo [ОШИБКА] Отправка разрешена из ветки main. Текущая ветка не переименована.
  exit /b 1
)
exit /b 0

:check_only
call :check_git || exit /b 1
call :configure_remote || exit /b 1
call :check_branch || exit /b 1
call :test_server || exit /b 1
call :check_vps_tools --check-only || exit /b 1
where gh >nul 2>nul || (
  echo [ОШИБКА] GitHub CLI не найден в PATH.
  exit /b 1
)
gh auth status >nul 2>nul || (
  echo [ОШИБКА] GitHub CLI не авторизован.
  exit /b 1
)
echo [OK] Git, GitHub Actions, серверные тесты, SSH и файлы деплоя проверены.
exit /b 0

:deploy_vps_cli
call :test_server || exit /b 1
call :deploy_vps || exit /b 1
echo [OK] Сервер VPS успешно обновлён и отвечает на проверку.
exit /b 0

:deploy_all_cli
call :check_git || exit /b 1
call :configure_remote || exit /b 1
call :check_branch || exit /b 1
call :test_server || exit /b 1
call :commit_and_push "Deploy VALHEM" 1 || exit /b 1
call :deploy_vps || exit /b 1
call :wait_pages || exit /b 1
echo [OK] Полный деплой завершён: Pages и VPS обновлены и проверены.
exit /b 0

:command_failed
echo.
echo [ОШИБКА] Команда завершилась неудачно. Сообщение выше содержит причину.

:pause_menu
echo.
pause
goto menu
