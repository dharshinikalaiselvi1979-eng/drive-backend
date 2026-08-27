require('dotenv').config();
const cors = require('cors');
const multer = require('multer');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 } // 200MB per file — raise/lower as needed
});
const express = require('express');
const supabase = require('./supabaseClient');

const app = express();

app.use(cors({
    origin: 'http://localhost:5173', // your frontend origin
    credentials: true
}));

// Ensures Chrome's Local Network Access check passes on the
// preflight (OPTIONS) request too — not just the real request
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

app.use(express.json());

const requireAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ success: false, error: 'No authorization token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    req.userId = data.user.id;
    next();
};

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Backend is alive!');
});

app.get('/db-test', async (req, res) => {
    const { data, error } = await supabase.storage.listBuckets();
    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true, message: 'Connected to Supabase!', buckets: data });
});

app.get('/files', requireAuth, async (req, res) => {
    const { folder_id } = req.query;

    let query = supabase.from('files').select('*').eq('user_id', req.userId).is('deleted_at', null);
    query = folder_id ? query.eq('folder_id', folder_id) : query.is('folder_id', null);

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }

    const { data: storageFiles } = await supabase.storage.from('user-files').list('');

    const filesWithUrls = await Promise.all(data.map(async (file) => {
        const matchingStorageFile = storageFiles?.find(f => f.name.endsWith(file.name));
        let url = null;
        if (matchingStorageFile) {
            const { data: urlData } = await supabase.storage.from('user-files').createSignedUrl(matchingStorageFile.name, 3600);
            url = urlData?.signedUrl || null;
        }
        return { ...file, url };
    }));

    res.json(filesWithUrls);
});

app.get('/files/trash', requireAuth, async (req, res) => {
    const { data, error } = await supabase
        .from('files')
        .select('*')
        .eq('user_id', req.userId)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    res.json(data);
});

app.post('/files', async (req, res) => {
    const { name, size } = req.body;

    if (!name || size === undefined) {
        return res.status(400).json({ error: 'Name and size are required' });
    }

    const { data, error } = await supabase
        .from('files')
        .insert([{ name, size }])
        .select();

    if (error) {
        return res.status(500).json({ error: error.message });
    }
    res.status(201).json(data[0]);
});

app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file provided' });
    }

    const { folder_id } = req.body;
    const fileName = `${Date.now()}-${req.file.originalname}`;

    const { data, error } = await supabase.storage
        .from('user-files')
        .upload(fileName, req.file.buffer, {
            contentType: req.file.mimetype
        });

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }

    const { data: signedUrlData } = await supabase.storage
        .from('user-files')
        .createSignedUrl(fileName, 3600);

    const { data: dbData, error: dbError } = await supabase
        .from('files')
        .insert([{ name: req.file.originalname, size: req.file.size, user_id: req.userId, folder_id: folder_id || null }])
        .select();

    if (dbError) {
        return res.status(500).json({ success: false, error: dbError.message });
    }

    res.json({
        success: true,
        message: 'File uploaded!',
        url: signedUrlData?.signedUrl || null,
        record: dbData[0]
    });
});

app.patch('/files/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const { data, error } = await supabase
        .from('files')
        .update({ name: name.trim() })
        .eq('id', id)
        .eq('user_id', req.userId)
        .select();

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, record: data[0] });
});

app.patch('/files/:id/star', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { starred } = req.body;

    if (typeof starred !== 'boolean') {
        return res.status(400).json({ success: false, error: 'starred (boolean) is required' });
    }

    const { data, error } = await supabase
        .from('files')
        .update({ starred })
        .eq('id', id)
        .eq('user_id', req.userId)
        .select();

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, record: data[0] });
});

app.patch('/files/:id/move', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { folder_id } = req.body;

    if (folder_id) {
        const { data: folder, error: folderError } = await supabase
            .from('folders')
            .select('id')
            .eq('id', folder_id)
            .eq('user_id', req.userId)
            .single();

        if (folderError || !folder) {
            return res.status(404).json({ success: false, error: 'Destination folder not found' });
        }
    }

    const { data, error } = await supabase
        .from('files')
        .update({ folder_id: folder_id || null })
        .eq('id', id)
        .eq('user_id', req.userId)
        .select();

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, message: 'File moved', record: data[0] });
});

app.patch('/files/:id/restore', requireAuth, async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from('files')
        .update({ deleted_at: null })
        .eq('id', id)
        .eq('user_id', req.userId)
        .select();

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, message: 'File restored', record: data[0] });
});

app.delete('/files/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from('files')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', req.userId)
        .select();

    if (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    res.json({ success: true, message: 'File moved to trash' });
});
app.delete('/files/:id/permanent', requireAuth, async (req, res) => {
    const { id } = req.params;

    const { data: fileRecord, error: fetchError } = await supabase
        .from('files')
        .select('*')
        .eq('id', id)
        .eq('user_id', req.userId)
        .single();

    if (fetchError || !fileRecord) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }

    const { data: storageFiles } = await supabase.storage.from('user-files').list('');
    const matchingStorageFile = storageFiles?.find(f => f.name.endsWith(fileRecord.name));

    if (matchingStorageFile) {
        const { error: storageError } = await supabase.storage
            .from('user-files')
            .remove([matchingStorageFile.name]);

        if (storageError) {
            return res.status(500).json({ success: false, error: storageError.message });
        }
    }

    const { error: dbError } = await supabase
        .from('files')
        .delete()
        .eq('id', id)
        .eq('user_id', req.userId);

    if (dbError) {
        return res.status(500).json({ success: false, error: dbError.message });
    }

    res.json({ success: true, message: 'File permanently deleted' });
});
app.get('/folders', requireAuth, async (req, res) => {
    const { parent_id } = req.query;

    let query = supabase.from('folders').select('*').eq('user_id', req.userId);
    query = parent_id ? query.eq('parent_id', parent_id) : query.is('parent_id', null);

    const { data, error } = await query.order('name');
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json(data);
});

app.post('/folders', requireAuth, async (req, res) => {
    const { name, parent_id } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Name is required' });
    }

    if (parent_id) {
        const { data: parent, error: parentError } = await supabase
            .from('folders')
            .select('id')
            .eq('id', parent_id)
            .eq('user_id', req.userId)
            .single();

        if (parentError || !parent) {
            return res.status(404).json({ success: false, error: 'Parent folder not found' });
        }
    }

    const { data, error } = await supabase
        .from('folders')
        .insert([{ name: name.trim(), parent_id: parent_id || null, user_id: req.userId }])
        .select();

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.status(201).json(data[0]);
});

app.get('/folders/:id/path', requireAuth, async (req, res) => {
    const path = [];
    let currentId = req.params.id;

    while (currentId) {
        const { data, error } = await supabase
            .from('folders')
            .select('id, name, parent_id')
            .eq('id', currentId)
            .eq('user_id', req.userId)
            .single();

        if (error || !data) break;
        path.unshift({ id: data.id, name: data.name });
        currentId = data.parent_id;
    }

    res.json(path);
});

// Handle multer errors (e.g. file too large) cleanly instead of a raw 500
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    }
    if (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
    next();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});