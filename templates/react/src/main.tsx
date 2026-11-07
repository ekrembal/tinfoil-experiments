import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './components/ui/button';
import './index.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><main className="p-8"><h1 className="text-3xl font-bold mb-4">Offline starter</h1><Button>Ready to build</Button></main></React.StrictMode>);
