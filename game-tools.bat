@echo off
rem Запуск игры, отправка изменений и обновление GitHub Pages из папки батника.
setlocal EnableExtensions DisableDelayedExpansion
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
if /i "%~1"=="--check-local" goto check_local_cli
if /i "%~1"=="--qa" goto qa_cli
if /i "%~1"=="--deploy-pages" goto deploy_pages_cli
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
echo  [7] QA: проверить игру и сервер
echo  [0] Выход
echo.
choice /c 12345670 /n /m "Выберите действие: "
if errorlevel 8 goto :eof
if errorlevel 7 goto qa_menu
if errorlevel 6 goto open_pages
if errorlevel 5 goto update_vps
if errorlevel 4 goto update_pages
if errorlevel 3 goto deploy_all
if errorlevel 2 goto publish
if errorlevel 1 goto launch
goto menu

:launch
cls
echo Запуск VALHEM...
call :check_local || goto pause_menu
start "" "%CD%\index.html"
if errorlevel 1 goto command_failed
goto menu

:check_local
for %%F in (index.html startup.js startup.css sw.js manifest.webmanifest icon.svg icon-192.png icon-512.png) do (
  if not exist "%%F" (
    echo [ОШИБКА] Не найден файл VALHEM: %%F
    exit /b 1
  )
)
if not exist "assets\divan\divan.webp" (
  echo [ОШИБКА] Не найдена заставка VALHEM.
  exit /b 1
)
if not exist "assets\music\VALHEM - Viking Trail.opus" (
  echo [ОШИБКА] Не найдена музыка меню VALHEM.
  exit /b 1
)
if not exist "assets\music\VALHEM - Viking Trail.wav" (
  echo [ОШИБКА] Не найден запасной WAV для музыки VALHEM.
  exit /b 1
)
exit /b 0

:check_local_cli
call :check_local || exit /b 1
echo [OK] Файлы VALHEM на месте. Локальный запуск не требует npm.
exit /b 0

:qa_menu
cls
call :qa
if errorlevel 1 goto command_failed
goto pause_menu

:qa_cli
call :qa || exit /b 1
exit /b 0

:qa
call :check_local || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Он нужен для QA.
  exit /b 1
)
if not exist "scripts\valhem-qa.cjs" (
  echo [ОШИБКА] Не найден scripts\valhem-qa.cjs.
  exit /b 1
)
node "scripts\valhem-qa.cjs"
if errorlevel 1 exit /b 1
call :test_server || exit /b 1
if not exist "scripts\solo-checkpoint-browser-qa.cjs" (
  echo [ОШИБКА] Не найден scripts\solo-checkpoint-browser-qa.cjs.
  exit /b 1
)
node "scripts\solo-checkpoint-browser-qa.cjs"
if errorlevel 1 exit /b 1
if not exist "scripts\online-browser-qa.cjs" (
  echo [ОШИБКА] Не найден scripts\online-browser-qa.cjs.
  exit /b 1
)
node "scripts\online-browser-qa.cjs"
if errorlevel 1 exit /b 1
echo [OK] QA VALHEM пройдено.
exit /b 0

:publish
cls
call :check_publish_source || goto pause_menu
call :check_git || goto pause_menu
call :configure_remote || goto pause_menu
call :check_branch || goto pause_menu
call :check_git_author || goto pause_menu

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
call :check_publish_source || goto pause_menu
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
call :check_publish_source || goto pause_menu
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
call :check_git_author || exit /b 1
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
where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Он нужен для проверки сервера VALHEM.
  exit /b 1
)
for %%F in (server\package.json server\package-lock.json server\src\server.js server\src\store.js server\src\rooms.js server\test\api.test.js server\test\rooms.test.js server\test\store.test.js) do (
  if not exist "%%F" (
    echo [ОШИБКА] Не найден файл сервера VALHEM: %%F
    exit /b 1
  )
)
findstr /i /c:"valhem-online-server" "server\package.json" >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] server\package.json не принадлежит серверу VALHEM.
  exit /b 1
)
pushd "server"
echo Проверяю серверную часть...
node --test test\api.test.js test\rooms.test.js test\store.test.js
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

rem Упаковываем только VALHEM: в общей папке server есть файлы другой игры.
tar -czf "%LOCAL_ARCHIVE%" -C "server" package.json package-lock.json src/server.js src/store.js src/rooms.js test/api.test.js test/rooms.test.js test/store.test.js
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

:check_git_author
git var GIT_AUTHOR_IDENT >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Git не знает автора коммита для VALHEM.
  echo Укажите имя и адрес для этого репозитория:
  echo   git config --local user.name "Ваше имя"
  echo   git config --local user.email "Ваш адрес GitHub"
  exit /b 1
)
exit /b 0
:check_publish_source
call :check_local || exit /b 1
if exist "package.json" (
  findstr /i /c:"deepforge" "package.json" >nul 2>nul
  if not errorlevel 1 (
    echo [ОШИБКА] Эта папка также содержит DEEPFORGE. Публикация VALHEM из неё небезопасна.
    echo Используйте отдельную копию репозитория VALHEM. Локальный запуск остаётся доступен.
    exit /b 1
  )
)
exit /b 0

:configure_remote
set "ACTUAL_REMOTE="
for /f "delims=" %%U in ('git remote get-url origin 2^>nul') do set "ACTUAL_REMOTE=%%U"
if not defined ACTUAL_REMOTE (
 echo [ОШИБКА] У репозитория нет origin. Публикация VALHEM остановлена.
 exit /b 1
)
if not "%ACTUAL_REMOTE%"=="%REPO_URL%" (
 echo [ОШИБКА] origin указывает на другой репозиторий: %ACTUAL_REMOTE%
 echo VALHEM публикуется только из отдельной копии %REPO_URL%
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
call :check_publish_source || exit /b 1
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

:deploy_pages_cli
call :check_publish_source || exit /b 1
call :check_git || exit /b 1
call :configure_remote || exit /b 1
call :check_branch || exit /b 1
call :commit_and_push "Update GitHub Pages" 1 || exit /b 1
call :wait_pages || exit /b 1
echo [OK] GitHub Pages успешно обновлён.
exit /b 0

:deploy_all_cli
call :check_publish_source || exit /b 1
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
