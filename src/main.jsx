import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// 纯净挂载，已按照“避坑指引”彻底移除对不存在的 index.css 的引入
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
