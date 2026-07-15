const { owner, repo, branch } = document.body.dataset
const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
const supportedExtensions = new Set(['jpg', 'jpeg', 'png', 'jfif', 'webp', 'gif', 'bmp'])
const maxFileSize = 20 * 1024 * 1024
const maxTotalSize = 80 * 1024 * 1024
const maxFiles = 50

const authPanel = document.getElementById('auth-panel')
const authForm = document.getElementById('auth-form')
const authStatus = document.getElementById('auth-status')
const tokenInput = document.getElementById('token-input')
const sessionPanel = document.getElementById('session-panel')
const uploadPanel = document.getElementById('upload-panel')
const uploadForm = document.getElementById('upload-form')
const uploadButton = document.getElementById('upload-btn')
const uploadProgress = document.getElementById('upload-progress')
const statusMessage = document.getElementById('status-message')
const categorySelect = document.getElementById('category-select')
const newCategoryToggle = document.getElementById('new-category-toggle')
const newCategoryFields = document.getElementById('new-category-fields')
const fileInput = document.getElementById('file-input')
const dropZone = document.getElementById('drop-zone')
const previewList = document.getElementById('preview-list')

let token = ''
let connected = false
let categoriesDocument = defaultCategoriesDocument()
let selectedFiles = []
let draggedIndex = null

class ApiError extends Error {
    constructor(message, status, data) {
        super(message)
        this.status = status
        this.data = data
    }
}

function defaultCategoriesDocument() {
    return {
        categories: [
            { id: 'default', label: '未分类', order: 0, sensitive: false },
        ],
    }
}

async function githubApi(path, options = {}) {
    const response = await fetch(`${apiRoot}${path}`, {
        method: options.method || 'GET',
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (response.status === 404 && options.allow404) return null
    const data = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) {
        throw new ApiError(data?.message || `GitHub API ${response.status}`, response.status, data)
    }
    return data
}

async function githubUser() {
    const response = await fetch('https://api.github.com/user', {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(data?.message || 'Token 无效', response.status, data)
    return data
}

function decodeBase64Utf8(value) {
    const binary = atob(value.replace(/\s/g, ''))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
}

async function fileToBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
}

function cloneDocument(value) {
    return JSON.parse(JSON.stringify(value))
}

function setAuthStatus(message, isError = false) {
    authStatus.textContent = message
    if (isError) authStatus.dataset.state = 'error'
    else delete authStatus.dataset.state
}

function setStatus(message, state = '') {
    statusMessage.replaceChildren()
    statusMessage.textContent = message
    if (state) statusMessage.dataset.state = state
    else delete statusMessage.dataset.state
}

function setProgress(value, visible = true) {
    uploadProgress.hidden = !visible
    uploadProgress.value = value
}

function updateUploadButton() {
    uploadButton.disabled = !connected || selectedFiles.length === 0
}

async function loadCategories() {
    const file = await githubApi(`/contents/meme/categories.json?ref=${encodeURIComponent(branch)}`, {
        allow404: true,
    })
    if (!file) {
        categoriesDocument = defaultCategoriesDocument()
    } else {
        const parsed = JSON.parse(decodeBase64Utf8(file.content))
        categoriesDocument = Array.isArray(parsed.categories)
            ? parsed
            : defaultCategoriesDocument()
    }
    if (!categoriesDocument.categories.some((category) => category.id === 'default')) {
        categoriesDocument.categories.unshift(defaultCategoriesDocument().categories[0])
    }
    renderCategories()
}

function renderCategories(selectedId = categorySelect.value || 'default') {
    categorySelect.replaceChildren()
    const categories = [...categoriesDocument.categories].sort(
        (left, right) => Number(left.order || 0) - Number(right.order || 0)
    )
    for (const category of categories) {
        const option = document.createElement('option')
        option.value = category.id
        option.textContent = category.sensitive
            ? `${category.label} · 敏感`
            : category.label
        categorySelect.append(option)
    }
    if ([...categorySelect.options].some((option) => option.value === selectedId)) {
        categorySelect.value = selectedId
    }
}

async function connect(nextToken) {
    token = nextToken.trim()
    if (!token) throw new Error('请输入 GitHub Token')
    setAuthStatus('正在连接...')
    const [user] = await Promise.all([
        githubUser(),
        githubApi(''),
    ])
    await loadCategories()
    connected = true
    document.getElementById('github-user').textContent = `@${user.login}`
    authPanel.hidden = true
    sessionPanel.hidden = false
    uploadPanel.hidden = false
    tokenInput.value = ''
    setAuthStatus('')
    updateUploadButton()
}

function disconnect() {
    token = ''
    connected = false
    authPanel.hidden = false
    sessionPanel.hidden = true
    uploadPanel.hidden = true
    setAuthStatus('')
    setStatus('')
    updateUploadButton()
}

function extensionOf(filename) {
    return filename.includes('.') ? filename.split('.').pop().toLowerCase() : ''
}

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function validateFiles(files) {
    if (selectedFiles.length + files.length > maxFiles) {
        throw new Error(`每次最多上传 ${maxFiles} 张图片`)
    }
    const totalSize = selectedFiles.reduce((sum, item) => sum + item.file.size, 0)
        + files.reduce((sum, file) => sum + file.size, 0)
    if (totalSize > maxTotalSize) throw new Error('本次上传总大小不能超过 80 MB')

    for (const file of files) {
        if (!supportedExtensions.has(extensionOf(file.name))) {
            throw new Error(`不支持的图片格式：${file.name}`)
        }
        if (file.size > maxFileSize) throw new Error(`${file.name} 超过 20 MB`)
    }
}

function addFiles(fileList) {
    const files = [...fileList]
    try {
        validateFiles(files)
        selectedFiles.push(
            ...files.map((file) => ({
                file,
                previewUrl: URL.createObjectURL(file),
            }))
        )
        renderPreviews()
        setStatus('')
    } catch (error) {
        setStatus(error.message, 'error')
    }
}

function moveFile(from, to) {
    if (to < 0 || to >= selectedFiles.length || from === to) return
    const [item] = selectedFiles.splice(from, 1)
    selectedFiles.splice(to, 0, item)
    renderPreviews()
}

function removeFile(index) {
    URL.revokeObjectURL(selectedFiles[index].previewUrl)
    selectedFiles.splice(index, 1)
    renderPreviews()
}

function previewAction(label, text, handler) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'secondary outline'
    button.title = label
    button.setAttribute('aria-label', label)
    button.textContent = text
    button.addEventListener('click', handler)
    return button
}

function renderPreviews() {
    previewList.replaceChildren()
    selectedFiles.forEach((item, index) => {
        const row = document.createElement('li')
        row.className = 'preview-item'
        row.draggable = true
        row.dataset.index = String(index)

        const image = document.createElement('img')
        image.src = item.previewUrl
        image.alt = ''

        const details = document.createElement('div')
        details.className = 'preview-details'
        const name = document.createElement('strong')
        name.textContent = item.file.name
        const size = document.createElement('small')
        size.textContent = `${index + 1} / ${selectedFiles.length} · ${formatBytes(item.file.size)}`
        details.append(name, size)

        const actions = document.createElement('div')
        actions.className = 'preview-actions'
        actions.append(
            previewAction('上移', '↑', () => moveFile(index, index - 1)),
            previewAction('下移', '↓', () => moveFile(index, index + 1)),
            previewAction('移除', '×', () => removeFile(index))
        )

        row.addEventListener('dragstart', () => {
            draggedIndex = index
        })
        row.addEventListener('dragover', (event) => event.preventDefault())
        row.addEventListener('drop', (event) => {
            event.preventDefault()
            if (draggedIndex !== null) moveFile(draggedIndex, index)
            draggedIndex = null
        })
        row.append(image, details, actions)
        previewList.append(row)
    })
    updateUploadButton()
}

function sanitizePathSegment(value) {
    return value
        .normalize('NFKC')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+|\.+$/g, '')
        .trim()
}

function sanitizeFilename(filename) {
    const extension = extensionOf(filename)
    const basename = filename.slice(0, filename.length - extension.length - 1)
    const safeBase = sanitizePathSegment(basename).replace(/\s+/g, '-') || 'image'
    return `${safeBase}.${extension}`
}

function timestamp() {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

function nextCategory() {
    if (!newCategoryToggle.checked) {
        return {
            id: categorySelect.value,
            document: cloneDocument(categoriesDocument),
            isNew: false,
        }
    }

    const id = document.getElementById('category-id').value.trim().toLowerCase()
    const label = document.getElementById('category-label').value.trim()
    const order = Number(document.getElementById('category-order').value)
    const sensitive = document.getElementById('category-sensitive').checked
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
        throw new Error('目录 ID 只能使用小写英文、数字和短横线')
    }
    if (!label) throw new Error('请输入分类显示名称')
    if (categoriesDocument.categories.some((category) => category.id === id)) {
        throw new Error(`分类 ${id} 已存在`)
    }

    const nextDocument = cloneDocument(categoriesDocument)
    nextDocument.categories.push({ id, label, order, sensitive })
    nextDocument.categories.sort((left, right) => Number(left.order) - Number(right.order))
    return { id, document: nextDocument, isNew: true }
}

function buildUploadPaths(categoryId) {
    const groupName = sanitizePathSegment(document.getElementById('group-name').value)
    const batchTimestamp = timestamp()
    if (groupName) {
        return selectedFiles.map((item, index) => {
            const extension = extensionOf(item.file.name)
            return `meme/${categoryId}/${groupName}/${String(index + 1).padStart(2, '0')}.${extension}`
        })
    }

    return selectedFiles.map((item, index) => {
        const filename = `${batchTimestamp}-${String(index + 1).padStart(2, '0')}-${sanitizeFilename(item.file.name)}`
        return categoryId === 'default' ? `meme/${filename}` : `meme/${categoryId}/${filename}`
    })
}

async function pathExists(path) {
    const result = await githubApi(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, {
        allow404: true,
    })
    return result !== null
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length)
    let nextIndex = 0
    async function run() {
        while (nextIndex < items.length) {
            const index = nextIndex
            nextIndex += 1
            results[index] = await worker(items[index], index)
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
    return results
}

async function createBatchCommit(category, paths, commitMessage) {
    const groupName = sanitizePathSegment(document.getElementById('group-name').value)
    if (groupName && await pathExists(`meme/${category.id}/${groupName}`)) {
        throw new Error(`多图组“${groupName}”已经存在，请换一个名称`)
    }

    setProgress(5)
    const ref = await githubApi(`/git/ref/heads/${encodeURIComponent(branch)}`)
    const baseCommitSha = ref.object.sha
    const baseCommit = await githubApi(`/git/commits/${baseCommitSha}`)
    setProgress(10)

    let uploaded = 0
    const fileTreeEntries = await mapWithConcurrency(selectedFiles, 4, async (item, index) => {
        const content = await fileToBase64(item.file)
        const blob = await githubApi('/git/blobs', {
            method: 'POST',
            body: { content, encoding: 'base64' },
        })
        uploaded += 1
        setProgress(10 + Math.round((uploaded / selectedFiles.length) * 60))
        return {
            path: paths[index],
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
        }
    })

    if (category.isNew) {
        const categoryJson = `${JSON.stringify(category.document, null, 2)}\n`
        const categoryBlob = await githubApi('/git/blobs', {
            method: 'POST',
            body: { content: encodeBase64Utf8(categoryJson), encoding: 'base64' },
        })
        fileTreeEntries.push({
            path: 'meme/categories.json',
            mode: '100644',
            type: 'blob',
            sha: categoryBlob.sha,
        })
    }

    setProgress(75)
    const tree = await githubApi('/git/trees', {
        method: 'POST',
        body: { base_tree: baseCommit.tree.sha, tree: fileTreeEntries },
    })
    const commit = await githubApi('/git/commits', {
        method: 'POST',
        body: {
            message: commitMessage,
            tree: tree.sha,
            parents: [baseCommitSha],
        },
    })
    setProgress(90)
    await githubApi(`/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
    })
    setProgress(100)
    return commit.sha
}

function clearSelectedFiles() {
    selectedFiles.forEach((item) => URL.revokeObjectURL(item.previewUrl))
    selectedFiles = []
    fileInput.value = ''
    previewList.replaceChildren()
    document.getElementById('group-name').value = ''
    updateUploadButton()
}

authForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submitButton = authForm.querySelector('button[type="submit"]')
    submitButton.disabled = true
    try {
        await connect(tokenInput.value)
    } catch (error) {
        token = ''
        setAuthStatus(error.message, true)
    } finally {
        submitButton.disabled = false
    }
})

document.getElementById('disconnect-btn').addEventListener('click', disconnect)
newCategoryToggle.addEventListener('change', () => {
    newCategoryFields.hidden = !newCategoryToggle.checked
})
fileInput.addEventListener('change', () => addFiles(fileInput.files))

for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, (event) => {
        event.preventDefault()
        dropZone.classList.add('is-dragging')
    })
}
for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, (event) => {
        event.preventDefault()
        dropZone.classList.remove('is-dragging')
    })
}
dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files))

uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    uploadButton.disabled = true
    setStatus('正在创建提交...')
    setProgress(0)
    try {
        const category = nextCategory()
        const paths = buildUploadPaths(category.id)
        const commitMessage = document.getElementById('commit-message').value.trim()
            || 'feat: upload memes from web'
        const commitSha = await createBatchCommit(category, paths, commitMessage)

        if (category.isNew) {
            categoriesDocument = category.document
            renderCategories(category.id)
            newCategoryToggle.checked = false
            newCategoryFields.hidden = true
        }
        clearSelectedFiles()
        statusMessage.replaceChildren()
        const link = document.createElement('a')
        link.href = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${commitSha}`
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = '提交成功，查看 commit'
        statusMessage.append(link)
        statusMessage.dataset.state = 'success'
    } catch (error) {
        const message = error.status === 409 || error.status === 422
            ? '分支在上传期间发生变化，请重新上传'
            : error.message
        setStatus(message, 'error')
    } finally {
        setTimeout(() => setProgress(0, false), 1200)
        updateUploadButton()
    }
})
