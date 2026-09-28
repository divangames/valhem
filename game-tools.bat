@echo off
rem Запуск игры, отправка изменений и обновление GitHub Pages из папки батника.
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1
title VALHEM - управление проектом

set "REPO_URL=https://github.com/divangames/valhem.git"
set "PAGES_URL=https://divangames.github.io/valhem/"
if /i "%~1"=="--check" goto check_only

:menu
cls
echo ==============================================
echo        VALHEM - управление проектом
echo ==============================================
echo.
echo  [1] Запустить игру
echo  [2] Commit + push на GitHub
echo  [3] Обновить GitHub Pages
echo  [4] Открыть страницу игры
echo  [0] Выход
echo.
choice /c 12340 /n /m "Выберите действие: "
if errorlevel 5 goto :eof
if errorlevel 4 goto open_pages
if errorlevel 3 goto update_pages
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

:update_pages
cls
echo Обновление GitHub Pages выполняется через GitHub Actions.
call :check_git || goto pause_menu
call :configure_remote || goto pause_menu
call :check_branch || goto pause_menu

rem .gitignore сам исключает back; отдельный pathspec игнорируемой папки вызывает ошибку Git.
git add -A -- .
if errorlevel 1 goto command_failed
git diff --cached --quiet
if errorlevel 2 goto command_failed
if errorlevel 1 (
  git commit -m "Update GitHub Pages"
  if errorlevel 1 goto command_failed
 ) else (
  rem Новый коммит запускает push-workflow даже при отсутствии изменений файлов.
  git commit --allow-empty -m "Refresh GitHub Pages"
  if errorlevel 1 goto command_failed
)

git push -u origin main
if errorlevel 1 goto command_failed

echo.
echo Изменения отправлены. Проверяю GitHub Pages...
where gh >nul 2>nul
if errorlevel 1 (
  echo Для проверки результата откройте GitHub Actions:
  echo https://github.com/divangames/valhem/actions
  goto pages_link
)
gh auth status >nul 2>nul
if errorlevel 1 (
  echo Для проверки результата через терминал выполните gh auth login.
  goto pages_link
)
gh run list --repo divangames/valhem --workflow deploy-pages.yml --branch main --limit 3
echo Страница обновится после успешного завершения Deploy game to GitHub Pages.
:pages_link
echo %PAGES_URL%
start "" "%PAGES_URL%"
goto pause_menu

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
echo [OK] Git, origin, main и папка проекта проверены.
exit /b 0

:command_failed
echo.
echo [ОШИБКА] Команда завершилась неудачно. Сообщение выше содержит причину.

:pause_menu
echo.
pause
goto menu
