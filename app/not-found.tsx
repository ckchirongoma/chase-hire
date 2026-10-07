import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card mx-auto max-w-md text-center">
      <h1 className="h1">Page not found</h1>
      <Link href="/" className="underline">Go home</Link>
    </div>
  );
}
