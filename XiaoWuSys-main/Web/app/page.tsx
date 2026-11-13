import { redirect } from 'next/navigation';
import { HOME_PATH } from '@/components/layout/nav-items';

// "/" opens the first section. The (app) auth gate sends signed-out visitors to /login.
export default function Home() {
  redirect(HOME_PATH);
}
