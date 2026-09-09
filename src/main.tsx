import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import BankingWorkbench from './dealgraph/BankingWorkbench';

createRoot(document.getElementById('root')!).render(<StrictMode><BankingWorkbench /></StrictMode>);
