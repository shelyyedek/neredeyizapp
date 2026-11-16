@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title Katılan - APK Oluşturucu

echo.
echo ===============================================
echo           KATILAN - APK OLUSTURUCU
echo ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
 echo HATA: Node.js bulunamadi. Node.js kurmalisiniz.
 goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
 echo HATA: npm bulunamadi.
 goto :fail
)

if exist "%LOCALAPPDATA%\Android\Sdk" (
 set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
 set "ANDROID_SDK_ROOT=%LOCALAPPDATA%\Android\Sdk"
)
if not defined JAVA_HOME if exist "C:\Program Files\Android\Android Studio\jbr" (
 set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
)
if defined JAVA_HOME set "PATH=%JAVA_HOME%\bin;%PATH%"
if defined ANDROID_HOME set "PATH=%ANDROID_HOME%\platform-tools;%PATH%"

if not defined ANDROID_HOME (
 echo HATA: Android SDK bulunamadi. Android Studio'dan SDK yukleyin.
 goto :fail
)

rem Paketler sadece ilk kurulumda veya eksikse kurulur. Eski APK dosyasi hata halinde korunur.
echo [1/4] Bagimliliklar kontrol ediliyor...
if not exist "node_modules\expo\package.json" (
 call npm install --no-audit --no-fund --prefer-offline
 if errorlevel 1 goto :fail
)
if not exist "node_modules\expo-notifications\package.json" (
 call npm install --no-audit --no-fund --prefer-offline
 if errorlevel 1 goto :fail
)

rem Mevcut Gradle debug anahtari varsa temiz prebuild oncesinde koru.
rem Eski APK da bu anahtarla imzalandiysa guncelleme kurulumuna yardimci olur.
set "OLD_KEY_BACKUP=%TEMP%\katilan-keystore-%RANDOM%.bak"
if exist "android\app\debug.keystore" (
 copy /Y "android\app\debug.keystore" "%OLD_KEY_BACKUP%" >nul
)

rem Ad degisikligi Android kaynak dosyalarina temiz aktarilir.
echo [2/4] Android projesi Katılan icin hazirlaniyor...
call npx expo prebuild --platform android --clean --no-install
if errorlevel 1 goto :fail

if exist "%OLD_KEY_BACKUP%" (
 copy /Y "%OLD_KEY_BACKUP%" "android\app\debug.keystore" >nul
 del /Q "%OLD_KEY_BACKUP%" >nul 2>nul
)

if defined ANDROID_HOME (
 set "SDK_FWD=%ANDROID_HOME:\=/%"
 >"android\local.properties" echo sdk.dir=%SDK_FWD%
)

echo [3/4] Release APK derleniyor...
pushd android
call gradlew.bat assembleRelease --build-cache
if errorlevel 1 (
 popd
 goto :fail
)
popd

set "APK_SRC=android\app\build\outputs\apk\release\app-release.apk"
if not exist "%APK_SRC%" (
 echo HATA: APK ciktisi bulunamadi.
 goto :fail
)

copy /Y "%APK_SRC%" "%~dp0Katılan.apk" >nul
if errorlevel 1 goto :fail

echo [4/4] Basarili. APK:
echo %~dp0Katılan.apk
echo.
echo UYARI: Guncelleme icin eski APK ile ayni Android imzasi gereklidir.
echo Mevcut uygulamayi silmeyin. Yedek almadan veri temizlemeyin.
echo.
explorer /select,"%~dp0Katılan.apk"
pause
exit /b 0

:fail
echo.
echo APK olusturulamadi. Yukaridaki HATA satirlarini inceleyin.
pause
exit /b 1
