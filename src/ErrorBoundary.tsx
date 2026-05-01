import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

/** 顶层错误边界：单个子组件渲染抛错时不再整页空白，而是给出可读信息和恢复入口。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 同步打印到 webview 控制台以便排查
    console.error('[LegalBiz] render error:', error, info)
    this.setState({ info })
  }

  reset = () => {
    this.setState({ error: null, info: null })
  }

  reload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          padding: '32px 28px',
          maxWidth: 760,
          margin: '40px auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          color: '#1f1d19',
          background: '#fffdf7',
          border: '1px solid #ded8cb',
          borderRadius: 10,
          lineHeight: 1.6,
        }}
      >
        <h1 style={{ margin: '0 0 8px 0', fontSize: 18 }}>渲染异常</h1>
        <p style={{ margin: '0 0 12px 0', color: '#796f61', fontSize: 13 }}>
          界面里有组件抛出了异常。这通常是数据格式与代码不匹配（例如旧配置文件、空字段）造成的。
          请尝试"返回上一步"，或刷新窗口重新加载。完整错误已打印到控制台。
        </p>
        <pre
          style={{
            background: '#1f1d19',
            color: '#fffaf0',
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            overflow: 'auto',
            maxHeight: 240,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {String(this.state.error.message || this.state.error)}
          {'\n\n'}
          {this.state.error.stack ?? ''}
        </pre>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid #d8d0c1',
              background: '#fffaf0',
              cursor: 'pointer',
            }}
          >
            返回
          </button>
          <button
            type="button"
            onClick={this.reload}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid #1f1d19',
              background: '#1f1d19',
              color: '#fffaf0',
              cursor: 'pointer',
            }}
          >
            重载窗口
          </button>
        </div>
      </div>
    )
  }
}
