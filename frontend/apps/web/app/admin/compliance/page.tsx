import { Providers } from '@/lib/chat/Providers';
import { AdminOperationsClient } from '../operations/AdminOperationsClient';
export default function Page() { return <Providers><AdminOperationsClient view="compliance" /></Providers>; }
