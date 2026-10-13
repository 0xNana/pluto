import type { Metadata } from 'next';
import { DisclosureWorkspace } from '../../components/disclosure-workspace';

export const metadata: Metadata = { title: 'Workspace · Pluto' };
export default function Page() { return <DisclosureWorkspace />; }
