const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function copyDirectoryRecursive(sourceDir, targetDir) {
    ensureDirectory(targetDir);

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            copyDirectoryRecursive(sourcePath, targetPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function getDevelopmentPythonScriptsDir() {
    return path.join(__dirname, '..', '..', '..', 'python_scripts');
}

function getBundledPythonScriptsDir() {
    return path.join(app.getAppPath(), 'python_scripts');
}

function getResourcePythonScriptsDir() {
    return path.join(process.resourcesPath, 'python_scripts');
}

function getPreparedPythonScriptsDir() {
    if (!app.isPackaged) {
        return getDevelopmentPythonScriptsDir();
    }

    const preparedDir = path.join(os.tmpdir(), 'snipe_python_scripts', app.getVersion());
    const sourceCandidates = [
        getBundledPythonScriptsDir(),
        getResourcePythonScriptsDir()
    ];

    const sourceDir = sourceCandidates.find((candidate) => fs.existsSync(candidate));
    if (!sourceDir) {
        throw new Error('Не удалось найти директорию python_scripts в packaged bundle');
    }

    const markerPath = path.join(preparedDir, '.prepared');
    if (!fs.existsSync(markerPath)) {
        if (fs.existsSync(preparedDir)) {
            fs.rmSync(preparedDir, { recursive: true, force: true });
        }

        copyDirectoryRecursive(sourceDir, preparedDir);
        fs.writeFileSync(markerPath, `prepared-from:${sourceDir}`);
        console.log(`🐍 Python scripts prepared in temp dir: ${preparedDir}`);
    }

    return preparedDir;
}

function resolvePythonScriptPath(scriptName) {
    const scriptsDir = getPreparedPythonScriptsDir();
    const scriptPath = path.join(scriptsDir, scriptName);

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Python script not found: ${scriptName}`);
    }

    return scriptPath;
}

module.exports = {
    getPreparedPythonScriptsDir,
    resolvePythonScriptPath
};
