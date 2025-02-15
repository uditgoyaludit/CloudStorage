const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const sharp = require('sharp');

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Serve static files from the "public" directory (for CSS, images, etc.)
app.use(express.static('public'));

// ---------------------------
// Secure Session Middleware
// ---------------------------
app.use(session({
  name: 'sessionId', // Custom cookie name (optional)
  secret: process.env.SESSION_SECRET || 'your-very-strong-secret', // Use a strong secret stored in .env
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true in production (requires HTTPS)
    httpOnly: true,                           // Prevents client-side JS from reading the cookie
    sameSite: 'strict',                       // Helps mitigate CSRF attacks
    maxAge: 24 * 60 * 60 * 1000                // 1 day expiry (adjust as needed)
  }
}));

// ---------------------------
// Supabase Setup
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------
// Telegram Configuration
// ---------------------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHUNK_SIZE = 19 * 1024 * 1024; // 19MB chunks

// ---------------------------
// Ensure Downloads Folder Exists
// ---------------------------
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}
app.use('/downloads', express.static(downloadsDir));

// ---------------------------
// Body Parser Middleware
// ---------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------
// Authentication Middleware
// ---------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/login');
}

// ---------------------------
// Auth Routes
// ---------------------------
function generateVideoThumbnail(filePath) {
  return new Promise((resolve, reject) => {
    const thumbnailPath = filePath + '-thumbnail.png';
    ffmpeg(filePath)
      .screenshots({
        timestamps: ['00:00:01'],
        filename: path.basename(thumbnailPath),
        folder: path.dirname(thumbnailPath),
        size: '200x?'  // width of 200px; height auto
      })
      .on('end', () => {
        fs.readFile(thumbnailPath, (err, data) => {
          if (err) return reject(err);
          // Remove the temporary thumbnail file after reading it
          fs.unlink(thumbnailPath, () => {});
          resolve(data.toString('base64'));
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

// GET /login — Render a login form
app.get('/login', (req, res) => {
  res.send(`
   <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CloudStore Login</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background-color: #f8f9fa;
            flex-direction: column;
        }
        .login-container, .signup-container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1);
            width: 400px;
        }
        .cloud-icon {
            font-size: 40px;
            color: #0d6efd;
        }
        .form-label {
            text-align: left;
            display: block;
        }
        .hidden {
            display: none;
        }
    </style>
    <script>
        function toggleForms() {
            document.getElementById("loginForm").classList.toggle("hidden");
            document.getElementById("signupForm").classList.toggle("hidden");
        }
    </script>
</head>
<body>
    <div class="text-center">
        <!-- logo -->
        <div class="cloud-icon">☁️</div>
        <h2 class="fw-bold mt-2" id="formTitle">Sign in to CloudStore</h2>
        
        <div id="loginForm" class="login-container mt-3">
            <form action="/login" method="post">
                <div class="mb-3 text-start">
                    <label for="email" class="form-label">Email address</label>
                    <input name ="email" type="email" class="form-control" id="email">
                </div>
                <div class="mb-3 text-start">
                    <label for="password" class="form-label">Password</label>
                    <input name ="password" type="password" class="form-control" id="password">
                </div>
                <button type="submit" class="btn btn-primary w-100">Sign in</button>
            </form>
            <p class="mt-3">Don't have an account? <a href="#" class="text-primary" onclick="toggleForms(); document.getElementById('formTitle').innerText='Create an account';">Sign up here</a></p>
        </div>
        
        <div id="signupForm" class="signup-container mt-3 hidden">
            <form action="/register" method="post">
                <div class="mb-3 text-start">
                    <label for="signup-email" class="form-label">Email address</label>
                    <input name ="email" type="email" class="form-control" id="signup-email">
                </div>
                <div class="mb-3 text-start">
                    <label for="signup-password" class="form-label">Password</label>
                    <input name="password"type="password" class="form-control" id="signup-password">
                </div>
                <div class="mb-3 text-start">
                    <label for="confirm-password" class="form-label">Confirm Password</label>
                    <input name="cpassword" type="password" class="form-control" id="confirm-password">
                </div>
                <button type="submit" class="btn btn-primary w-100">Sign up</button>
            </form>
            <p class="mt-3">Already have an account? <a href="#" class="text-primary" onclick="toggleForms(); document.getElementById('formTitle').innerText='Sign in to CloudStore';">Login</a></p>
        </div>
    </div>
</body>
</html>

  `);
});

// POST /login — Process login credentials using Supabase Auth
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    console.error("Login error:", error);
    return res.send("Login error: " + (error ? error.message : "Unknown error"));
  }

  req.session.regenerate((err) => {
    if (err) {
      console.error("Session regeneration error:", err);
      return res.status(500).send("Session error");
    }
    req.session.user = data.user; // store user details in the new session
    console.log("New Session ID:", req.sessionID);  // Log the new session ID
    res.redirect('/dashboard');
  });
});

// GET /register — Render a registration form
// app.get('/register', (req, res) => {
//   res.send(`
//     <html>
//       <head>
//         <title>Register</title>
//         <link rel="stylesheet" href="/dashboard.css">
//       </head>
//       <body>
//         <h1>Register</h1>
//         <form action="/register" method="post">
//           <label>Email: <input type="email" name="email" required></label><br>
//           <label>Password: <input type="password" name="password" required></label><br>
//           <button type="submit">Register</button>
//         </form>
//         <p>Already have an account? <a href="/login">Login here</a></p>
//       </body>
//     </html>
//   `);
// });

// POST /register — Create a new user via Supabase Auth and log them in
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error || !data.user) {
    console.error("Registration error:", error);
    return res.send("Registration error: " + (error ? error.message : "Unknown error"));
  }

  // Optionally, you can log the user in immediately after registration
  req.session.regenerate((err) => {
    if (err) {
      console.error("Session regeneration error:", err);
      return res.status(500).send("Session error");
    }
    
    res.redirect('/dashboard');
  });
});

// GET /logout — Log out the user
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ---------------------------
// Main Application Routes
// ---------------------------

// Home page — Shows login/register links if not logged in.
// Only when logged in, the upload form (upload button) is displayed.

async function sendToTelegram(filePath, originalName) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('document', fs.createReadStream(filePath));
  formData.append('caption', `Uploaded: ${originalName}`);
  const response = await axios.post(url, formData, {
    headers: formData.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return response.data.result.document.file_id;
}

// If the file is large, split it into 19MB chunks, upload each chunk, and return an array of file_ids.
async function splitAndUploadChunks(filePath, originalName) {
  const fileBuffer = fs.readFileSync(filePath);
  const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);
  const fileIds = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunk = fileBuffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const chunkPath = `${filePath}.part${i}`;
    fs.writeFileSync(chunkPath, chunk);
    const fileId = await sendToTelegram(chunkPath, `${originalName}.part${i + 1}/${totalChunks}`);
    fileIds.push(fileId);
    fs.unlinkSync(chunkPath);
  }
  return fileIds;
}

app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const filePath = req.file.path;
  const fileSize = fs.statSync(filePath).size;
  
  // Generate thumbnail for image or video files
  let thumbnail = null;
  const ext = path.extname(req.file.originalname).toLowerCase().substring(1); // removes the dot
  if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) {
    try {
      // Resize image to a width of 200px (height auto) and output as PNG
      const thumbBuffer = await sharp(filePath)
        .resize(200)
        .png()
        .toBuffer();
      thumbnail = thumbBuffer.toString('base64');
    } catch (err) {
      console.error("Error generating image thumbnail:", err);
    }
  } else if (['mp4', 'webm', 'avi', 'mov'].includes(ext)) {
    try {
      thumbnail = await generateVideoThumbnail(filePath);
    } catch (err) {
      console.error("Error generating video thumbnail:", err);
    }
  }

  // Process file upload to Telegram (with chunking if necessary)
  let fileIds = [];
  try {
    if (fileSize > 40 * 1024 * 1024) {
      fileIds = await splitAndUploadChunks(filePath, req.file.originalname);
    } else {
      const fileId = await sendToTelegram(filePath, req.file.originalname);
      fileIds.push(fileId);
    }
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error("Error uploading file to Telegram:", error);
    return res.status(500).send("Error uploading file");
  }

  const uniqueId = fileIds[0];

  // Save the file record in Supabase including the thumbnail
  try {
    const { error: supaError } = await supabase
      .from('uploads')
      .insert([{
        unique_id: uniqueId,
        file_ids: fileIds,
        original_name: req.file.originalname,
        user_id: req.session.user.id,  // ensure your uploads table has a user_id column
        thumbnail: thumbnail  // new thumbnail field (can be null if not an image/video)
      }]);
    if (supaError) {
      console.error("Supabase error:", supaError);
      return res.status(500).send("Error saving file record");
    }
  } catch (error) {
    console.error("Error saving file record:", error);
    return res.status(500).send("Error saving file record");
  }

  res.redirect('/dashboard');

});
app.post('/delete/:uniqueId', requireAuth, async (req, res) => {
  const { uniqueId } = req.params;

  // Delete the record only if it belongs to the current user
  const { error } = await supabase
    .from('uploads')
    .delete()
    .eq('unique_id', uniqueId)
    .eq('user_id', req.session.user.id);

  if (error) {
    console.error("Error deleting upload:", error);
    return res.status(500).send("Error deleting file record");
  }

  res.redirect('/dashboard');
});


app.get('/dashboard', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('uploads')
    .select('*')
    .eq('user_id', req.session.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error("Error fetching uploads:", error);
    return res.status(500).send("Error fetching uploads");
  }

  res.send(`
    <html>
      <head>
        <title>Dashboard</title>
        <link rel="stylesheet" href="/dashboard.css">
      </head>
      <body>
      <div class="dashboard-container">
      <p>Logged in as: ${req.session.user.email} (<a href="/logout">Logout</a>)</p>
      <form id="uploadForm" action="/upload" method="post" enctype="multipart/form-data">
      <div class="upload-container">
  <div class="upload-area" id="uploadArea">
    <p>Drag and drop files here, or</p>
    <label for="fileInput" class="file-input-label">Select File</label>
    <input type="file" id="fileInput" name="file" required>
  </div>
  <div id="selectedFiles" style="margin-top: 10px; font-weight: bold;"></div>
</div>

      <button type="submit">Upload</button>
    </form>

    <script>
      document.getElementById('fileInput').addEventListener('change', (event) => {
        const files = event.target.files;
        const fileList = document.getElementById('selectedFiles');
        fileList.innerHTML = '';
        if (files.length > 0) {
          for (const file of files) {
            const fileElement = document.createElement('div');
            fileElement.textContent = file.name;
            fileList.appendChild(fileElement);
          }
        }
      });

      const uploadArea = document.getElementById('uploadArea');
      uploadArea.addEventListener('dragover', (event) => {
        event.preventDefault();
        uploadArea.style.backgroundColor = '#e0e0e0';
        event.dataTransfer.dropEffect = 'copy';
      });
      uploadArea.addEventListener('dragleave', (event) => {
        event.preventDefault();
        uploadArea.style.backgroundColor = '#f9f9f9';
      });
      uploadArea.addEventListener('drop', (event) => {
        event.preventDefault();
        uploadArea.style.backgroundColor = '#f9f9f9';
        const files = event.dataTransfer.files;
        document.getElementById('fileInput').files = files;
        const fileList = document.getElementById('selectedFiles');
        fileList.innerHTML = '';
        for (const file of files) {
          const fileElement = document.createElement('div');
          fileElement.textContent = file.name;
          fileList.appendChild(fileElement);
        }
      });
    </script>    
      <h1>Your Uploaded Files Dashboard</h1>
          <div class="file-grid">
            ${data.map(upload => `
              <div class="file-card">
                <img src="${upload.thumbnail 
  ? 'data:image/png;base64,' + upload.thumbnail 
  : '/file-icon.png'}" 
  alt="File Thumbnail" 
  style="max-width:200px;"
  onerror="this.onerror=null; this.src='/thumb.jpeg';">

                <p>${upload.original_name}</p>
                <p>${upload.created_at ? new Date(upload.created_at).toLocaleString() : ''}</p>
               <button onclick="window.location.href='/merge/${upload.unique_id}'">Download</button>
                <form action="/delete/${upload.unique_id}" method="post" onsubmit="return confirm('Are you sure you want to delete this file?');">
                  <button type="submit">Delete</button>
                </form>
              </div>
            `).join('')}
          </div>
          <br>
          <a href="/dashboard">Back to Dashboard</a>
        </div>
      </body>
    </html>
  `);
});

app.get('/file/:fileId', requireAuth, async (req, res) => {
  const { fileId } = req.params;
  try {
    const fileUrlRes = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const filePath = fileUrlRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(500).send('Error fetching file from Telegram');
  }
});
app.get('/merge/:uniqueId', requireAuth, async (req, res) => {
    const { uniqueId } = req.params;
    const { data, error } = await supabase
      .from('uploads')
      .select('*')
      .eq('unique_id', uniqueId)
      .single();
  
    if (error || !data) {
      console.error("Error fetching file record:", error);
      return res.status(404).send("File record not found");
    }
  
    // Verify that the current user is the owner.
    if (data.user_id !== req.session.user.id) {
      return res.status(403).send("Access denied");
    }
  
    const fileIds = data.file_ids;
    const fileIdsJSON = JSON.stringify(fileIds);
    // Get the original file name from the database record.
    const originalName = data.original_name;
  
    // Determine the file type from the original name or from headers, or by checking the file extension.
    const fileExtension = originalName.split('.').pop().toLowerCase();
    let previewType = null;
  
    // Check if the file is an image, video, or other playable content.
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif'];
    const videoExtensions = ['mp4', 'webm', 'avi', 'mov'];
  
    if (imageExtensions.includes(fileExtension)) {
      previewType = 'image';
    } else if (videoExtensions.includes(fileExtension)) {
      previewType = 'video';
    }
  
    res.send(`
      <html>
        <head>
          <title>Client‐Side File Merge</title>
          <link rel="stylesheet" href="/dashboard.css">
        </head>
        <body>
          <div class="merge-container">
            <h1>Preview</h1>
            <div id="loadingIndicator" style="display: block; text-align: center;">
              <p>Loading... Please wait.</p>
              <div class="spinner" style="margin: 20px auto; border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 2s linear infinite;"></div>
            </div>
            <div id="previewContainer" style="display: none; text-align: center;">
              <!-- Preview will be shown here -->
            </div>
            <div id="downloadLink" style="display: none; text-align: center;">
              <a href="#" id="downloadButton" class="btn btn-primary">Download File</a>
            </div>
          </div>
  
          <script>
            const fileIds = ${fileIdsJSON};
            const originalName = ${JSON.stringify(originalName)};
            const previewType = ${JSON.stringify(previewType)};
  
            async function fetchFilePart(fileId) {
              const response = await fetch('/file/' + fileId);
              return await response.arrayBuffer();
            }
  
            async function mergeFiles() {
              try {
                const parts = await Promise.all(fileIds.map(id => fetchFilePart(id)));
                const totalLength = parts.reduce((sum, buf) => sum + buf.byteLength, 0);
                const mergedArray = new Uint8Array(totalLength);
                let offset = 0;
                for (const buf of parts) {
                  mergedArray.set(new Uint8Array(buf), offset);
                  offset += buf.byteLength;
                }
  
                const blob = new Blob([mergedArray], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const downloadLink = document.getElementById('downloadButton');
                downloadLink.href = url;
                downloadLink.download = originalName;
  
                // Preview handling for images and videos
                if (previewType === 'image') {
                  const previewContainer = document.getElementById('previewContainer');
                  const imgElement = document.createElement('img');
                  imgElement.src = url;
                  imgElement.style.maxWidth = '100%';
                  previewContainer.appendChild(imgElement);
                  previewContainer.style.display = 'block';
                } else if (previewType === 'video') {
                  const previewContainer = document.getElementById('previewContainer');
                  const videoElement = document.createElement('video');
                  videoElement.src = url;
                  videoElement.controls = true;
                  videoElement.style.maxWidth = '100%';
                  previewContainer.appendChild(videoElement);
                  previewContainer.style.display = 'block';
                }
  
                // Hide the loading indicator and show the download link
                document.getElementById('loadingIndicator').style.display = 'none';
                document.getElementById('downloadLink').style.display = 'block';
              } catch (err) {
                console.error('Error Loading files:', err);
              }
            }
  
            mergeFiles();
          </script>
  
          <style>
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          </style>
          <br>
          <a href="/dashboard">Back to Dashboard</a>
        </body>
      </html>
    `);
  });
  

app.listen(8000, () =>
  console.log("Server running on port 8000 ")
);
