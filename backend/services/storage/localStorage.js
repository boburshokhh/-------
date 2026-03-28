const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function computeSha256(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function upload(filePath, objectKey) {
    ensureDir(config.UPLOAD_DIR);
    const dest = path.join(config.UPLOAD_DIR, path.basename(objectKey));
    if (filePath !== dest) {
        fs.copyFileSync(filePath, dest);
    }
    const stats = fs.statSync(dest);
    const checksum = computeSha256(dest);
    return {
        bucket: 'local',
        key: path.basename(objectKey),
        size: stats.size,
        checksum,
        etag: checksum,
    };
}

async function download(objectKey) {
    const filePath = path.join(config.UPLOAD_DIR, path.basename(objectKey));
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
}

async function remove(objectKey) {
    const filePath = path.join(config.UPLOAD_DIR, path.basename(objectKey));
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
        console.warn(`[LOCAL-STORAGE] Delete failed: ${e.message}`);
    }
}

async function exists(objectKey) {
    return fs.existsSync(path.join(config.UPLOAD_DIR, path.basename(objectKey)));
}

async function getFileChecksum(filePath) {
    return computeSha256(filePath);
}

async function getFileSize(filePath) {
    const stats = fs.statSync(filePath);
    return stats.size;
}

module.exports = { upload, download, remove, exists, getFileChecksum, getFileSize };
