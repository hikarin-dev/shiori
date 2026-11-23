import { useTitle } from '@/lib/title';

export default function NotFound() {
  useTitle();
  return <p className="p-5">Not found.</p>;
}
