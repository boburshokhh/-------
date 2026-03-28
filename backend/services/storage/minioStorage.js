const Minio = require('minio');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config');

let client = null;

function getClient() {
    if (!client) {
        client = new Minio.Client({
            endPoint: config.MINIO_ENDPOINT,
            port: config.MINIO_PORT,
            useSSL: config.MINIO_USE_SSL,
            accessKey: config.MINIO_ACCESS_KEY,
            secretKey: config.MINIO_SECRET_KEY,
        });
    }
    return client;
}

async function ensureBucket() {
    const mc = getClient();
    const bucket = config.MINIO_BUCKET;
    const exists = await mc.bucketExists(bucket);
    if (!exists) {
        await mc.makeBucket(bucket);
        console.log(`[MINIO] Bucket "${bucket}" created`);
    }
}

function computeSha256(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function upload(filePath, objectKey) {
    await ensureBucket();
    const mc = getClient();
    const bucket = config.MINIO_BUCKET;

    const checksum = computeSha256(filePath);
    const stats = fs.statSync(filePath);

    const metaData = { 'Content-Type': 'application/pdf', 'x-amz-checksum-sha256': checksum };
    const etag = await mc.fPutObject(bucket, objectKey, filePath, metaData);

    console.log(`[MINIO] Uploaded ${objectKey} (${stats.size} bytes, sha256=${checksum.slice(0, 12)}…)`);
    return {
        bucket,
        key: objectKey,
        size: stats.size,
        checksum,
        etag: typeof etag === 'string' ? etag : (etag?.etag || ''),
    };
}

async function download(objectKey) {
    const mc = getClient();
    const bucket = config.MINIO_BUCKET;
    const chunks = [];
    const stream = await mc.getObject(bucket, objectKey);
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

async function remove(objectKey) {
    try {
        const mc = getClient();
        await mc.removeObject(config.MINIO_BUCKET, objectKey);
        console.log(`[MINIO] Deleted ${objectKey}`);
    } catch (e) {
        console.warn(`[MINIO] Delete failed for ${objectKey}: ${e.message}`);
    }
}

async function exists(objectKey) {
    try {
        const mc = getClient();
        await mc.statObject(config.MINIO_BUCKET, objectKey);
        return true;
    } catch {
        return false;
    }
}

async function getFileChecksum(filePath) {
    return computeSha256(filePath);
}

async function getFileSize(filePath) {
    return fs.statSync(filePath).size;
}

module.exports = { upload, download, remove, exists, getFileChecksum, getFileSize, ensureBucket };
