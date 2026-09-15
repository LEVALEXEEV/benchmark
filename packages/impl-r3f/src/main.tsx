import { createRoot } from 'react-dom/client';
import { App } from './App.js';

// StrictMode НЕ используется намеренно: double-invocation в dev ломает
// одно-разовый запуск MetricsCollector и удваивает прогрев. Для тестов
// измерения корректнее идентичный production-режим монтирования.
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
