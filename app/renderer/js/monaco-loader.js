// Monaco AMD loader bootstrap for ShieldPress Local renderer.
window.ShieldPressMonaco = {
  _loading: null,
  _editor: null,
  _monaco: null,

  vsPath() {
    // remote-session.html and index.html both live under app/renderer/
    return new URL("../../node_modules/monaco-editor/min/vs", window.location.href).href;
  },

  load() {
    if (this._monaco) return Promise.resolve(this._monaco);
    if (this._loading) return this._loading;
    this._loading = new Promise((resolve, reject) => {
      const vs = this.vsPath();
      const script = document.createElement("script");
      script.src = `${vs}/loader.js`;
      script.onload = () => {
        try {
          window.require.config({ paths: { vs } });
          window.require(["vs/editor/editor.main"], () => {
            this._monaco = window.monaco;
            resolve(this._monaco);
          });
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error("Failed to load Monaco loader"));
      document.head.appendChild(script);
    });
    return this._loading;
  },

  async mount(container, { value = "", language = "plaintext", onCursor } = {}) {
    const monaco = await this.load();
    if (this._editor) {
      this._editor.dispose();
      this._editor = null;
    }
    container.innerHTML = "";
    this._editor = monaco.editor.create(container, {
      value,
      language: this._mapLanguage(language),
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 13,
      fontFamily: "'DejaVu Sans Mono', 'Liberation Mono', Consolas, monospace",
      scrollBeyondLastLine: false,
      wordWrap: "off",
      tabSize: 2,
      renderLineHighlight: "line",
      bracketPairColorization: { enabled: true },
    });
    this._editor.onDidChangeCursorPosition((e) => {
      onCursor?.({ line: e.position.lineNumber, column: e.position.column });
    });
    return this._editor;
  },

  _mapLanguage(language) {
    const map = {
      php: "php",
      javascript: "javascript",
      typescript: "typescript",
      json: "json",
      css: "css",
      scss: "scss",
      html: "html",
      xml: "xml",
      yaml: "yaml",
      shell: "shell",
      python: "python",
      sql: "sql",
      markdown: "markdown",
      nginx: "plaintext",
      apache: "plaintext",
      dotenv: "ini",
      plaintext: "plaintext",
    };
    return map[language] || "plaintext";
  },

  getValue() {
    return this._editor ? this._editor.getValue() : "";
  },

  setMarkers(markers) {
    if (!this._monaco || !this._editor) return;
    const model = this._editor.getModel();
    if (!model) return;
    this._monaco.editor.setModelMarkers(model, "shieldpress", markers || []);
  },

  revealLine(line) {
    if (!this._editor || !line) return;
    this._editor.revealLineInCenter(line);
    this._editor.setPosition({ lineNumber: line, column: 1 });
    this._editor.focus();
  },

  dispose() {
    if (this._editor) {
      this._editor.dispose();
      this._editor = null;
    }
  },
};
