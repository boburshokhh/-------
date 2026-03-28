const pg = require('../pgPool');

async function insertDocument(data) {
    const { rows } = await pg.query(`
        INSERT INTO documents (
            filename, original_name, original_name_raw, page_count, text_length,
            extraction_quality, parse_diagnostics, low_text_quality,
            text_raw, text_clean,
            storage_bucket, storage_key, mime_type, size_bytes, checksum_sha256
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING id
    `, [
        data.filename,
        data.original_name,
        data.original_name_raw || null,
        data.page_count || null,
        data.text_length || null,
        data.extraction_quality ?? null,
        data.parse_diagnostics ? JSON.stringify(data.parse_diagnostics) : null,
        data.low_text_quality || false,
        data.text_raw || null,
        data.text_clean || null,
        data.storage_bucket || null,
        data.storage_key || null,
        data.mime_type || 'application/pdf',
        data.size_bytes || null,
        data.checksum_sha256 || null,
    ]);
    return rows[0];
}

async function getDocumentById(id) {
    const { rows } = await pg.query('SELECT * FROM documents WHERE id = $1', [id]);
    return rows[0] || null;
}

async function getDocumentByChecksum(checksum, sizeBytes) {
    const { rows } = await pg.query(
        'SELECT * FROM documents WHERE checksum_sha256 = $1 AND size_bytes = $2 AND status = $3 LIMIT 1',
        [checksum, sizeBytes, 'active']
    );
    return rows[0] || null;
}

async function updateDocumentStatus(id, status) {
    await pg.query('UPDATE documents SET status = $1 WHERE id = $2', [status, id]);
}

async function deleteDocument(id) {
    await pg.query('DELETE FROM documents WHERE id = $1', [id]);
}

module.exports = {
    insertDocument,
    getDocumentById,
    getDocumentByChecksum,
    updateDocumentStatus,
    deleteDocument,
};
