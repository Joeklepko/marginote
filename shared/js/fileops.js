// 写穿层（桌面）：所有结构性文件操作在此统一执行——先改磁盘，再由调用方改内存/渲染。
// 仅在 isDesktopContext() 且已绑定工作目录时使用。
(function () {
  const A = () => (typeof fsApi === 'function' ? fsApi() : null);
  function noteRel(n) { return n.type === 'drawing' ? drawingRelPath(n) : noteRelPath(n); }
  function noteBody(n) { return n.type === 'drawing' ? drawingToFile(n) : noteToMarkdown(n, { mode: 'inline' }); }

  async function writeNoteFile(note) {
    const fs = A(); if (!fs) return;
    const rel = noteRel(note);
    if (note._srcPath && note._srcPath !== rel) { try { await fs.move(note._srcPath, rel); } catch {} }
    await fs.writeText(rel, noteBody(note));
    note._srcPath = rel; note._srcMtime = (typeof nowMs === 'function' ? nowMs() : new Date().getTime());
  }
  async function deleteNoteToTrash(note) {
    const fs = A(); if (!fs) return;
    const rel = note._srcPath || noteRel(note);
    await window.trash.moveToTrash({ path: rel, type: 'note', name: rel.split('/').pop() });
  }
  async function deleteNotebookToTrash(nbName) {
    if (!A()) return;
    await window.trash.moveToTrash({ path: nbName, type: 'notebook', name: nbName });
  }
  async function deleteFolderToTrash(nbName, folderName) {
    if (!A()) return;
    await window.trash.moveToTrash({ path: nbName + '/' + folderName, type: 'folder', name: folderName });
  }
  async function deleteTodoToTrash(todo) {
    const fs = A(); if (!fs) return;
    const rel = todo._srcPath || (TODO_DIR + '/' + safeName(todo.text || 'todo') + '.md');
    await window.trash.moveToTrash({ path: rel, type: 'todo', name: rel.split('/').pop() });
  }
  async function mkdirNotebook(nbName) { const fs = A(); if (fs) await fs.mkdir(nbName); }
  async function mkdirFolder(nbName, folderName) { const fs = A(); if (fs) await fs.mkdir(nbName + '/' + folderName); }
  async function renameDir(fromRel, toRel) { const fs = A(); if (fs) await fs.move(fromRel, toRel); }

  window.fileops = { writeNoteFile, deleteNoteToTrash, deleteNotebookToTrash, deleteFolderToTrash, deleteTodoToTrash, mkdirNotebook, mkdirFolder, renameDir };
})();
