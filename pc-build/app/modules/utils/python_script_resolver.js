const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

function buildDirectorySignature(sourceDir) {
    const hash = crypto.createHash('sha1');

    function walk(currentDir, relativePrefix = '') {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            const sourcePath = path.join(currentDir, entry.name);
            const relativePath = path.join(relativePrefix, entry.name);

            if (entry.isDirectory()) {
                hash.update(`dir:${relativePath}\n`);
                walk(sourcePath, relativePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const stats = fs.statSync(sourcePath);
            hash.update(`file:${relativePath}:${stats.size}:${stats.mtimeMs}\n`);
        }
    }

    walk(sourceDir);
    return hash.digest('hex');
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

function getPythonScriptSourceDir() {
    if (!app.isPackaged) {
        return getDevelopmentPythonScriptsDir();
    }

    const sourceCandidates = [
        getBundledPythonScriptsDir(),
        getResourcePythonScriptsDir()
    ];

    const sourceDir = sourceCandidates.find((candidate) => fs.existsSync(candidate));
    if (!sourceDir) {
        throw new Error('Не удалось найти директорию python_scripts в packaged bundle');
    }

    return sourceDir;
}

function getPreparedPythonScriptsDir(forceRefresh = false) {
    if (!app.isPackaged) {
        return getDevelopmentPythonScriptsDir();
    }

    const preparedDir = path.join(os.tmpdir(), 'snipe_python_scripts', app.getVersion());
    const sourceDir = getPythonScriptSourceDir();
    const sourceSignature = buildDirectorySignature(sourceDir);

    const markerPath = path.join(preparedDir, '.prepared');
    const markerContents = fs.existsSync(markerPath)
        ? fs.readFileSync(markerPath, 'utf8')
        : '';
    const expectedMarker = `prepared-from:${sourceDir}\nsignature:${sourceSignature}`;

    if (forceRefresh || markerContents !== expectedMarker) {
        if (fs.existsSync(preparedDir)) {
            fs.rmSync(preparedDir, { recursive: true, force: true });
        }

        copyDirectoryRecursive(sourceDir, preparedDir);
        fs.writeFileSync(markerPath, expectedMarker);
        console.log(`🐍 Python scripts prepared in temp dir: ${preparedDir}`);
    }

    return preparedDir;
}

function resolvePythonScriptPath(scriptName) {
    const resolveFromPreparedDir = (forceRefresh = false) => {
        const scriptsDir = getPreparedPythonScriptsDir(forceRefresh);
        return path.join(scriptsDir, scriptName);
    };

    let scriptPath = resolveFromPreparedDir(false);

    if (!fs.existsSync(scriptPath)) {
        scriptPath = resolveFromPreparedDir(true);
    }

    if (!fs.existsSync(scriptPath)) {
        const sourceDir = getPythonScriptSourceDir();
        const sourcePath = path.join(sourceDir, scriptName);
        if (fs.existsSync(sourcePath)) {
            return sourcePath;
        }

        throw new Error(`Python script not found: ${scriptName}`);
    }

    return scriptPath;
}

module.exports = {
    getPreparedPythonScriptsDir,
    getPythonScriptSourceDir,
    resolvePythonScriptPath
};
