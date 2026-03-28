const config = require('../../config');

let backend = null;

function getBackend() {
    if (!backend) {
        if (config.STORAGE_BACKEND === 'minio') {
            backend = require('./minioStorage');
        } else {
            backend = require('./localStorage');
        }
    }
    return backend;
}

function buildObjectKey(checksum, originalName) {
    const safe = originalName.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '_').slice(0, 200);
    return `documents/${checksum.slice(0, 16)}/${safe}`;
}

async function upload(filePath, originalName) {
    const b = getBackend();
    const checksum = await b.getFileChecksum(filePath);
    const size = await b.getFileSize(filePath);
    const objectKey = buildObjectKey(checksum, originalName);
    const result = await b.upload(filePath, objectKey);
    return { ...result, checksum, size };
}

async function download(objectKey) {
    return getBackend().download(objectKey);
}

async function remove(objectKey) {
    return getBackend().remove(objectKey);
}

async function exists(objectKey) {
    return getBackend().exists(objectKey);
}

async function init() {
    if (config.STORAGE_BACKEND === 'minio') {
        const minio = require('./minioStorage');
        await minio.ensureBucket();
        console.log(`[STORAGE] MinIO backend, bucket="${config.MINIO_BUCKET}"`);
    } else {
        console.log(`[STORAGE] Local backend, dir="${config.UPLOAD_DIR}"`);
    }
}

module.exports = { upload, download, remove, exists, init, buildObjectKey };
