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
const libraryPanel = document.getElementById('library-panel')
const librarySummary = document.getElementById('library-summary')
const libraryRefreshButton = document.getElementById('library-refresh-btn')
const libraryCategoryFilter = document.getElementById('library-category-filter')
const librarySearch = document.getElementById('library-search')
const librarySortOrder = document.getElementById('library-sort-order')
const librarySelectVisible = document.getElementById('library-select-visible')
const librarySelectedCount = document.getElementById('library-selected-count')
const libraryClearButton = document.getElementById('library-clear-btn')
const libraryTargetCategory = document.getElementById('library-target-category')
const libraryGroupName = document.getElementById('library-group-name')
const libraryCommitMessage = document.getElementById('library-commit-message')
const libraryMoveButton = document.getElementById('library-move-btn')
const libraryDeleteButton = document.getElementById('library-delete-btn')
const libraryStatus = document.getElementById('library-status')
const libraryList = document.getElementById('library-list')

let token = ''
let connected = false
let categoriesDocument = defaultCategoriesDocument()
let selectedFiles = []
let draggedIndex = null
let libraryHeadSha = ''
let libraryImages = []
let libraryEntries = []
let selectedLibraryPaths = new Set()
let dirtyGroupIds = new Set()
let libraryLoading = false
let catalogUploadTimes = new Map()
let pendingUploadTimes = new Map()
let uploadTimesBySha = new Map()

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

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

function setLibraryStatus(message, state = '') {
    libraryStatus.replaceChildren()
    libraryStatus.textContent = message
    if (state) libraryStatus.dataset.state = state
    else delete libraryStatus.dataset.state
}

function showCommitStatus(element, commitSha, label = '提交成功，查看 commit') {
    element.replaceChildren()
    const link = document.createElement('a')
    link.href = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${commitSha}`
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = label
    element.append(link)
    element.dataset.state = 'success'
}

function showCommitRefreshError(element, commitSha) {
    showCommitStatus(element, commitSha, '提交成功，查看 commit')
    element.append(document.createTextNode('；图片列表刷新失败，请点击刷新'))
    element.dataset.state = 'error'
}

function setProgress(value, visible = true) {
    uploadProgress.hidden = !visible
    uploadProgress.value = value
}

function updateUploadButton() {
    uploadButton.disabled = !connected || selectedFiles.length === 0
}

function availableCategories() {
    const categories = cloneDocument(categoriesDocument.categories)
    const knownIds = new Set(categories.map((category) => category.id))
    for (const image of libraryImages) {
        if (knownIds.has(image.category)) continue
        categories.push({
            id: image.category,
            label: image.category,
            order: categories.length * 10,
            sensitive: false,
        })
        knownIds.add(image.category)
    }
    return categories.sort((left, right) =>
        Number(left.order || 0) - Number(right.order || 0)
        || naturalCollator.compare(left.label, right.label)
    )
}

function fillCategorySelect(select, categories, selectedId, includeAll = false) {
    select.replaceChildren()
    if (includeAll) {
        const option = document.createElement('option')
        option.value = 'all'
        option.textContent = '全部分类'
        select.append(option)
    }
    for (const category of categories) {
        const option = document.createElement('option')
        option.value = category.id
        option.textContent = category.sensitive
            ? `${category.label} · 敏感`
            : category.label
        select.append(option)
    }
    if ([...select.options].some((option) => option.value === selectedId)) {
        select.value = selectedId
    }
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

function validUploadTime(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : ''
}

async function loadCatalogUploadTimes() {
    try {
        const catalog = (await import(`/static/scripts/config.js?v=${Date.now()}`)).default
        const uploads = catalog.uploads && typeof catalog.uploads === 'object'
            ? catalog.uploads
            : {}
        catalogUploadTimes = new Map(
            Object.entries(uploads)
                .map(([path, value]) => [path, validUploadTime(value)])
                .filter(([, value]) => value)
        )
    } catch {
        catalogUploadTimes = new Map()
    }
}

function inferredUploadTime(path) {
    const match = pathBasename(path).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/)
    if (!match) return ''
    const [, year, month, day, hour, minute, second] = match
    return new Date(Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
    )).toISOString()
}

function formatUploadTime(value) {
    if (!validUploadTime(value)) return ''
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(value))
}

function renderCategories(selectedId = categorySelect.value || 'default') {
    const categories = availableCategories()
    fillCategorySelect(categorySelect, categories, selectedId)
    fillCategorySelect(
        libraryTargetCategory,
        categories,
        libraryTargetCategory.value || selectedId
    )
    fillCategorySelect(
        libraryCategoryFilter,
        categories,
        libraryCategoryFilter.value || 'all',
        true
    )
}

async function connect(nextToken) {
    token = nextToken.trim()
    if (!token) throw new Error('请输入 GitHub Token')
    setAuthStatus('正在连接...')
    const [user] = await Promise.all([
        githubUser(),
        githubApi(''),
    ])
    await refreshRepositoryState()
    connected = true
    document.getElementById('github-user').textContent = `@${user.login}`
    authPanel.hidden = true
    sessionPanel.hidden = false
    uploadPanel.hidden = false
    libraryPanel.hidden = false
    tokenInput.value = ''
    setAuthStatus('')
    updateUploadButton()
    renderLibrary()
}

function disconnect() {
    token = ''
    connected = false
    authPanel.hidden = false
    sessionPanel.hidden = true
    uploadPanel.hidden = true
    libraryPanel.hidden = true
    libraryHeadSha = ''
    libraryImages = []
    libraryEntries = []
    selectedLibraryPaths.clear()
    dirtyGroupIds.clear()
    catalogUploadTimes.clear()
    pendingUploadTimes.clear()
    uploadTimesBySha.clear()
    libraryList.replaceChildren()
    setAuthStatus('')
    setStatus('')
    setLibraryStatus('')
    updateUploadButton()
    updateLibrarySelectionControls([])
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

function pathBasename(path) {
    return path.slice(path.lastIndexOf('/') + 1)
}

function pathDirectory(path) {
    const separator = path.lastIndexOf('/')
    return separator === -1 ? '' : path.slice(0, separator)
}

function imageUrl(path) {
    return `/${path.split('/').map(encodeURIComponent).join('/')}`
}

function treeImage(entry) {
    if (entry.type !== 'blob' || !entry.path.startsWith('meme/')) return null
    const parts = entry.path.split('/')
    if (parts.slice(1).some((part) => part.startsWith('.'))) return null
    if (!supportedExtensions.has(extensionOf(entry.path))) return null
    const relativeParts = parts.slice(1)
    return {
        path: entry.path,
        sha: entry.sha,
        size: Number(entry.size || 0),
        filename: relativeParts.at(-1),
        category: relativeParts.length === 1 ? 'default' : relativeParts[0],
        groupPath: relativeParts.length > 2
            ? relativeParts.slice(1, -1).join('/')
            : '',
        uploadedAt: pendingUploadTimes.get(entry.path)
            || uploadTimesBySha.get(entry.sha)
            || catalogUploadTimes.get(entry.path)
            || inferredUploadTime(entry.path),
    }
}

function rebuildLibraryEntries() {
    const entryMap = new Map()
    for (const image of libraryImages) {
        const grouped = Boolean(image.groupPath)
        const id = grouped ? `${image.category}/${image.groupPath}` : image.path
        if (!entryMap.has(id)) {
            const title = grouped
                ? image.groupPath.split('/').at(-1)
                : image.filename.slice(0, -(extensionOf(image.filename).length + 1))
            entryMap.set(id, {
                id,
                title,
                category: image.category,
                groupPath: image.groupPath,
                images: [],
            })
        }
        entryMap.get(id).images.push(image)
    }

    const categoryOrder = new Map(
        availableCategories().map((category) => [category.id, Number(category.order || 0)])
    )
    libraryEntries = [...entryMap.values()]
    for (const entry of libraryEntries) {
        entry.images.sort((left, right) => naturalCollator.compare(left.path, right.path))
        entry.uploadedAt = entry.images
            .map((image) => validUploadTime(image.uploadedAt))
            .filter(Boolean)
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || ''
    }
    libraryEntries.sort((left, right) =>
        (categoryOrder.get(left.category) ?? 10_000) - (categoryOrder.get(right.category) ?? 10_000)
        || naturalCollator.compare(left.id, right.id)
    )
}

async function loadRepositoryImages() {
    libraryLoading = true
    renderLibrary()
    try {
        const previousTimesBySha = new Map(uploadTimesBySha)
        libraryImages.forEach((image) => {
            if (image.uploadedAt) previousTimesBySha.set(image.sha, image.uploadedAt)
        })
        uploadTimesBySha = previousTimesBySha
        const ref = await githubApi(`/git/ref/heads/${encodeURIComponent(branch)}`)
        const commit = await githubApi(`/git/commits/${ref.object.sha}`)
        const tree = await githubApi(`/git/trees/${commit.tree.sha}?recursive=1`)
        if (tree.truncated) throw new Error('仓库文件过多，GitHub 未返回完整图片列表')

        libraryHeadSha = ref.object.sha
        libraryImages = tree.tree
            .map(treeImage)
            .filter(Boolean)
            .sort((left, right) => naturalCollator.compare(left.path, right.path))
        uploadTimesBySha = new Map(
            libraryImages
                .filter((image) => image.uploadedAt)
                .map((image) => [image.sha, image.uploadedAt])
        )
        selectedLibraryPaths.clear()
        dirtyGroupIds.clear()
        rebuildLibraryEntries()
        renderCategories()
    } finally {
        libraryLoading = false
        renderLibrary()
    }
}

function categoryLabel(categoryId) {
    return availableCategories().find((category) => category.id === categoryId)?.label || categoryId
}

function filteredLibraryEntries() {
    const categoryId = libraryCategoryFilter.value || 'all'
    const query = librarySearch.value.trim().toLocaleLowerCase()
    const filtered = libraryEntries.filter((entry) => {
        if (categoryId !== 'all' && entry.category !== categoryId) return false
        if (!query) return true
        return entry.title.toLocaleLowerCase().includes(query)
            || entry.groupPath.toLocaleLowerCase().includes(query)
            || entry.images.some((image) => image.path.toLocaleLowerCase().includes(query))
    })
    if (librarySortOrder.value === 'directory') return filtered

    const direction = librarySortOrder.value === 'newest' ? -1 : 1
    return filtered.sort((left, right) => {
        const leftTime = Date.parse(left.uploadedAt)
        const rightTime = Date.parse(right.uploadedAt)
        const leftKnown = Number.isFinite(leftTime)
        const rightKnown = Number.isFinite(rightTime)
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
        if (leftKnown && leftTime !== rightTime) return (leftTime - rightTime) * direction
        return naturalCollator.compare(left.id, right.id)
    })
}

function orderedLibraryImages() {
    return libraryEntries.flatMap((entry) => entry.images)
}

function updateLibrarySelectionControls(visibleEntries = filteredLibraryEntries()) {
    const visiblePaths = visibleEntries.flatMap((entry) => entry.images.map((image) => image.path))
    const selectedVisibleCount = visiblePaths.filter((path) => selectedLibraryPaths.has(path)).length
    librarySelectVisible.checked = visiblePaths.length > 0 && selectedVisibleCount === visiblePaths.length
    librarySelectVisible.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visiblePaths.length

    const selectedCount = selectedLibraryPaths.size
    librarySelectedCount.textContent = `已选择 ${selectedCount} 张`
    libraryClearButton.disabled = libraryLoading || selectedCount === 0
    libraryMoveButton.disabled = !connected || libraryLoading || selectedCount === 0
    libraryDeleteButton.disabled = !connected || libraryLoading || selectedCount === 0
    libraryRefreshButton.disabled = libraryLoading
}

function libraryIconButton(label, text, handler, disabled = false) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'secondary outline library-icon-button'
    button.title = label
    button.setAttribute('aria-label', label)
    button.textContent = text
    button.disabled = disabled
    button.addEventListener('click', handler)
    return button
}

function selectEntry(entry, selected) {
    for (const image of entry.images) {
        if (selected) selectedLibraryPaths.add(image.path)
        else selectedLibraryPaths.delete(image.path)
    }
    syncLibrarySelectionState()
}

function selectLibraryImage(path, selected) {
    if (selected) selectedLibraryPaths.add(path)
    else selectedLibraryPaths.delete(path)
    syncLibrarySelectionState()
}

function syncLibrarySelectionState() {
    libraryList.querySelectorAll('input[data-image-path]').forEach((checkbox) => {
        checkbox.checked = selectedLibraryPaths.has(checkbox.dataset.imagePath)
    })
    libraryList.querySelectorAll('input[data-entry-id]').forEach((checkbox) => {
        const entry = libraryEntries.find((item) => item.id === checkbox.dataset.entryId)
        if (!entry) return
        const selectedCount = entry.images.filter((image) =>
            selectedLibraryPaths.has(image.path)
        ).length
        checkbox.checked = selectedCount === entry.images.length
        checkbox.indeterminate = selectedCount > 0 && selectedCount < entry.images.length
    })
    updateLibrarySelectionControls()
}

function reorderLibraryGroup(entryId, fromIndex, toIndex) {
    const entry = libraryEntries.find((item) => item.id === entryId)
    if (!entry || toIndex < 0 || toIndex >= entry.images.length || fromIndex === toIndex) return
    const [image] = entry.images.splice(fromIndex, 1)
    entry.images.splice(toIndex, 0, image)
    dirtyGroupIds.add(entryId)
    renderLibrary()
}

function renderLibraryEntry(entry) {
    const article = document.createElement('article')
    article.className = 'library-entry'
    let header = null
    if (entry.groupPath) {
        header = document.createElement('header')
        header.className = 'library-entry-header'
        const selectLabel = document.createElement('label')
        selectLabel.className = 'library-entry-select'
        const entryCheckbox = document.createElement('input')
        entryCheckbox.type = 'checkbox'
        entryCheckbox.dataset.entryId = entry.id
        const selectedCount = entry.images.filter((image) =>
            selectedLibraryPaths.has(image.path)
        ).length
        entryCheckbox.checked = selectedCount === entry.images.length
        entryCheckbox.indeterminate = selectedCount > 0 && selectedCount < entry.images.length
        entryCheckbox.addEventListener('change', () => selectEntry(entry, entryCheckbox.checked))

        const heading = document.createElement('span')
        const title = document.createElement('strong')
        title.textContent = entry.title
        const meta = document.createElement('small')
        meta.textContent = `${categoryLabel(entry.category)} · ${entry.images.length} 张`
        heading.append(title, meta)
        selectLabel.append(entryCheckbox, heading)
        header.append(selectLabel)

        if (entry.images.length > 1) {
            const saveButton = document.createElement('button')
            saveButton.type = 'button'
            saveButton.className = 'secondary outline compact-button'
            saveButton.textContent = '保存顺序'
            saveButton.disabled = libraryLoading || !dirtyGroupIds.has(entry.id)
            saveButton.addEventListener('click', () => saveGroupOrder(entry.id))
            header.append(saveButton)
        }
    }

    const imageList = document.createElement('ol')
    imageList.className = 'library-images'
    entry.images.forEach((item, index) => {
        const row = document.createElement('li')
        row.className = 'library-image'
        const imageSelect = document.createElement('label')
        imageSelect.className = 'library-image-select'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = selectedLibraryPaths.has(item.path)
        checkbox.dataset.imagePath = item.path
        checkbox.addEventListener('change', () => selectLibraryImage(item.path, checkbox.checked))
        const image = document.createElement('img')
        image.src = imageUrl(item.path)
        image.alt = ''
        image.loading = 'lazy'
        const details = document.createElement('span')
        const filename = document.createElement('strong')
        filename.textContent = item.filename
        const path = document.createElement('small')
        const uploadedAt = formatUploadTime(item.uploadedAt)
        path.textContent = uploadedAt ? `${uploadedAt} · ${item.path}` : item.path
        details.append(filename, path)
        imageSelect.append(checkbox, image, details)
        row.append(imageSelect)

        if (entry.groupPath && entry.images.length > 1) {
            const actions = document.createElement('span')
            actions.className = 'library-order-actions'
            actions.append(
                libraryIconButton('上移', '↑', () => reorderLibraryGroup(entry.id, index, index - 1), index === 0),
                libraryIconButton('下移', '↓', () => reorderLibraryGroup(entry.id, index, index + 1), index === entry.images.length - 1)
            )
            row.append(actions)
        }
        imageList.append(row)
    })

    if (header) article.append(header)
    article.append(imageList)
    return article
}

function renderLibrary() {
    libraryList.replaceChildren()
    if (libraryLoading) {
        const loading = document.createElement('p')
        loading.setAttribute('aria-busy', 'true')
        loading.textContent = '正在读取仓库图片'
        libraryList.append(loading)
        updateLibrarySelectionControls([])
        return
    }

    const entries = filteredLibraryEntries()
    librarySummary.textContent = `${libraryEntries.length} 组/项，共 ${libraryImages.length} 张`
    if (entries.length === 0) {
        const empty = document.createElement('p')
        empty.className = 'library-empty'
        empty.textContent = '没有符合条件的图片'
        libraryList.append(empty)
    } else {
        const fragment = document.createDocumentFragment()
        entries.forEach((entry) => fragment.append(renderLibraryEntry(entry)))
        libraryList.append(fragment)
    }
    updateLibrarySelectionControls(entries)
}

function finalTreeChanges(affectedImages, assignments) {
    const currentByPath = new Map(libraryImages.map((image) => [image.path, image.sha]))
    const affectedPaths = new Set(affectedImages.map((image) => image.path))
    const changes = new Map()

    for (const [path, sha] of assignments) {
        if (currentByPath.has(path) && !affectedPaths.has(path) && currentByPath.get(path) !== sha) {
            throw new Error(`目标路径已存在：${path}`)
        }
    }
    for (const path of affectedPaths) {
        if (!assignments.has(path)) changes.set(path, null)
    }
    for (const [path, sha] of assignments) {
        if (currentByPath.get(path) !== sha) changes.set(path, sha)
    }

    return [...changes.entries()]
        .sort(([left], [right]) => naturalCollator.compare(left, right))
        .map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha }))
}

function uniqueImagePath(candidate, occupied) {
    if (!occupied.has(candidate)) {
        occupied.add(candidate)
        return candidate
    }
    const extension = extensionOf(candidate)
    const suffix = extension ? `.${extension}` : ''
    const base = suffix ? candidate.slice(0, -suffix.length) : candidate
    let index = 2
    while (occupied.has(`${base}-${index}${suffix}`)) index += 1
    const path = `${base}-${index}${suffix}`
    occupied.add(path)
    return path
}

function buildMoveChanges(categoryId, rawGroupName) {
    const orderedImages = orderedLibraryImages()
    const selectedImages = orderedImages.filter((image) => selectedLibraryPaths.has(image.path))
    if (selectedImages.length === 0) throw new Error('请先选择图片')

    const sanitizedGroupName = sanitizePathSegment(rawGroupName)
    if (rawGroupName.trim() && !sanitizedGroupName) throw new Error('请输入有效的多图组名称')

    if (sanitizedGroupName) {
        const targetDirectory = `meme/${categoryId}/${sanitizedGroupName}`
        const targetImages = orderedImages.filter((image) =>
            pathDirectory(image.path) === targetDirectory
            && !selectedLibraryPaths.has(image.path)
        )
        const affectedImages = [...targetImages, ...selectedImages]
        const assignments = new Map()
        affectedImages.forEach((image, index) => {
            const extension = extensionOf(image.path)
            const filename = `${String(index + 1).padStart(2, '0')}.${extension}`
            assignments.set(`${targetDirectory}/${filename}`, image.sha)
        })
        return finalTreeChanges(affectedImages, assignments)
    }

    const selectedPaths = new Set(selectedImages.map((image) => image.path))
    const occupied = new Set(
        libraryImages.filter((image) => !selectedPaths.has(image.path)).map((image) => image.path)
    )
    const assignments = new Map()
    for (const image of selectedImages) {
        const directory = categoryId === 'default' ? 'meme' : `meme/${categoryId}`
        const destination = uniqueImagePath(`${directory}/${pathBasename(image.path)}`, occupied)
        assignments.set(destination, image.sha)
    }
    return finalTreeChanges(selectedImages, assignments)
}

function buildGroupOrderChanges(entry) {
    const targetDirectory = pathDirectory(entry.images[0].path)
    const assignments = new Map()
    entry.images.forEach((image, index) => {
        const extension = extensionOf(image.path)
        assignments.set(
            `${targetDirectory}/${String(index + 1).padStart(2, '0')}.${extension}`,
            image.sha
        )
    })
    return finalTreeChanges(entry.images, assignments)
}

async function createImageTreeCommit(changes, commitMessage) {
    if (changes.length === 0) throw new Error('图片已经位于目标位置')
    const ref = await githubApi(`/git/ref/heads/${encodeURIComponent(branch)}`)
    if (ref.object.sha !== libraryHeadSha) {
        throw new ApiError('仓库已有新提交，请刷新图片列表后重试', 409)
    }
    const baseCommit = await githubApi(`/git/commits/${libraryHeadSha}`)
    const tree = await githubApi('/git/trees', {
        method: 'POST',
        body: { base_tree: baseCommit.tree.sha, tree: changes },
    })
    const commit = await githubApi('/git/commits', {
        method: 'POST',
        body: {
            message: commitMessage,
            tree: tree.sha,
            parents: [libraryHeadSha],
        },
    })
    await githubApi(`/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
    })
    return commit.sha
}

async function refreshRepositoryState() {
    await loadCategories()
    await loadCatalogUploadTimes()
    await loadRepositoryImages()
}

function libraryErrorMessage(error) {
    return error.status === 409 || error.status === 422
        ? '仓库在操作期间发生变化，请刷新后重试'
        : error.message
}

async function commitLibraryChanges(changes, fallbackMessage, pendingMessage) {
    libraryLoading = true
    renderLibrary()
    setLibraryStatus(pendingMessage)
    try {
        const message = libraryCommitMessage.value.trim() || fallbackMessage
        const commitSha = await createImageTreeCommit(changes, message)
        try {
            await refreshRepositoryState()
            showCommitStatus(libraryStatus, commitSha)
        } catch {
            showCommitRefreshError(libraryStatus, commitSha)
        }
        return true
    } catch (error) {
        setLibraryStatus(libraryErrorMessage(error), 'error')
        return false
    } finally {
        libraryLoading = false
        renderLibrary()
    }
}

async function saveGroupOrder(entryId) {
    const entry = libraryEntries.find((item) => item.id === entryId)
    if (!entry) return
    try {
        const changes = buildGroupOrderChanges(entry)
        await commitLibraryChanges(changes, `chore: reorder ${entry.title}`, '正在保存组内顺序...')
    } catch (error) {
        setLibraryStatus(error.message, 'error')
    }
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

libraryRefreshButton.addEventListener('click', async () => {
    if (dirtyGroupIds.size > 0 && !window.confirm('刷新会放弃尚未保存的组内顺序，是否继续？')) return
    setLibraryStatus('正在刷新...')
    try {
        await refreshRepositoryState()
        setLibraryStatus('已刷新', 'success')
    } catch (error) {
        setLibraryStatus(error.message, 'error')
    }
})

libraryCategoryFilter.addEventListener('change', renderLibrary)
librarySearch.addEventListener('input', renderLibrary)
librarySortOrder.addEventListener('change', renderLibrary)
librarySelectVisible.addEventListener('change', () => {
    const paths = filteredLibraryEntries().flatMap((entry) =>
        entry.images.map((image) => image.path)
    )
    for (const path of paths) {
        if (librarySelectVisible.checked) selectedLibraryPaths.add(path)
        else selectedLibraryPaths.delete(path)
    }
    syncLibrarySelectionState()
})
libraryClearButton.addEventListener('click', () => {
    selectedLibraryPaths.clear()
    syncLibrarySelectionState()
})
libraryMoveButton.addEventListener('click', async () => {
    try {
        if (dirtyGroupIds.size > 0) {
            throw new Error('请先保存组内顺序，或刷新列表放弃调整')
        }
        const targetCategory = libraryTargetCategory.value
        const changes = buildMoveChanges(targetCategory, libraryGroupName.value)
        const grouped = Boolean(sanitizePathSegment(libraryGroupName.value))
        const committed = await commitLibraryChanges(
            changes,
            grouped ? 'chore: group existing memes' : 'chore: move existing memes',
            grouped ? '正在移动并组成多图组...' : '正在移动图片...'
        )
        if (committed) libraryGroupName.value = ''
    } catch (error) {
        setLibraryStatus(error.message, 'error')
    }
})
libraryDeleteButton.addEventListener('click', async () => {
    if (dirtyGroupIds.size > 0) {
        setLibraryStatus('请先保存组内顺序，或刷新列表放弃调整', 'error')
        return
    }
    const selectedImages = orderedLibraryImages().filter((image) =>
        selectedLibraryPaths.has(image.path)
    )
    if (selectedImages.length === 0) return
    if (!window.confirm(`确定删除选中的 ${selectedImages.length} 张图片吗？此操作会提交到 GitHub。`)) return
    const changes = finalTreeChanges(selectedImages, new Map())
    await commitLibraryChanges(changes, 'chore: delete existing memes', '正在删除图片...')
})

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
    if (dirtyGroupIds.size > 0 && !window.confirm('上传后会刷新列表并放弃尚未保存的组内顺序，是否继续？')) return
    uploadButton.disabled = true
    setStatus('正在创建提交...')
    setProgress(0)
    try {
        const category = nextCategory()
        const paths = buildUploadPaths(category.id)
        const commitMessage = document.getElementById('commit-message').value.trim()
            || 'feat: upload memes from web'
        const commitSha = await createBatchCommit(category, paths, commitMessage)
        const uploadedAt = new Date().toISOString()
        paths.forEach((path) => pendingUploadTimes.set(path, uploadedAt))

        if (category.isNew) {
            categoriesDocument = category.document
            renderCategories(category.id)
            newCategoryToggle.checked = false
            newCategoryFields.hidden = true
        }
        clearSelectedFiles()
        showCommitStatus(statusMessage, commitSha)
        try {
            await refreshRepositoryState()
        } catch {
            showCommitRefreshError(statusMessage, commitSha)
        }
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
