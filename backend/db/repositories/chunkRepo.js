const pg = require('../pgPool');
const config = require('../../config');

async function getChunkHashesByDocumentId(documentId) {
    const { rows } = await pg.query(
        'SELECT id, content_hash FROM chunks WHERE document_id = $1',
        [documentId]
    );
    return rows;
}

async function insertChunks(documentId, chunks) {
    return pg.transaction(async (client) => {
        const inserted = [];
        for (const c of chunks) {
            const { rows } = await client.query(`
                INSERT INTO chunks (document_id, chunk_index, text, token_count, content_hash, page, section, heading)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                RETURNING id
            `, [
                documentId, c.index, c.text, c.tokens, c.content_hash,
                c.page ?? null, c.section ?? null, c.heading ?? null,
            ]);
            inserted.push({ ...c, id: rows[0].id });
        }
        return inserted;
    });
}

async function insertEmbeddings(embeddings, embeddingModel) {
    if (embeddings.length === 0) return;
    await pg.transaction(async (client) => {
        for (const c of embeddings) {
            if (!c.embedding) continue;
            await client.query(`
                INSERT INTO chunk_embeddings (chunk_id, embedding_model, embedding, dims)
                VALUES ($1,$2,$3,$4)
                ON CONFLICT (chunk_id, embedding_model) DO UPDATE SET embedding = $3, dims = $4
            `, [c.id, embeddingModel, JSON.stringify(c.embedding), c.embedding.length]);
        }
    });
}

async function insertSummary(chunkId, facts) {
    await pg.query(`
        INSERT INTO chunk_summaries (chunk_id, summary_text)
        VALUES ($1, $2)
        ON CONFLICT (chunk_id) DO UPDATE SET summary_text = $2
    `, [chunkId, JSON.stringify(facts)]);
}

async function loadIndexedChunks(documentId) {
    const embeddingModel = config.EMBEDDING_MODEL || 'gemini-embedding-001';
    const { rows } = await pg.query(`
        SELECT
            c.id,
            c.document_id,
            c.chunk_index,
            c.text,
            c.token_count,
            c.content_hash,
            c.page,
            c.section,
            c.heading,
            ce.embedding,
            ce.embedding_model,
            cs.summary_text
        FROM chunks c
        LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.embedding_model = $1
        LEFT JOIN chunk_summaries cs ON cs.chunk_id = c.id
        WHERE c.document_id = $2
        ORDER BY c.chunk_index ASC
    `, [embeddingModel, documentId]);

    return rows.map(row => ({
        id:           row.id,
        document_id:  row.document_id,
        chunk_index:  row.chunk_index,
        text:         row.text,
        token_count:  row.token_count,
        content_hash: row.content_hash,
        page:         row.page ?? null,
        section:      row.section ?? null,
        heading:      row.heading ?? null,
        embedding:    row.embedding || null,
        summary:      row.summary_text || [],
    }));
}

async function hasIndex(documentId) {
    const { rows } = await pg.query(
        'SELECT COUNT(*)::int AS cnt FROM chunks WHERE document_id = $1',
        [documentId]
    );
    return rows[0].cnt > 0;
}

module.exports = {
    getChunkHashesByDocumentId,
    insertChunks,
    insertEmbeddings,
    insertSummary,
    loadIndexedChunks,
    hasIndex,
};
