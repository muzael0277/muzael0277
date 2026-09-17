export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Deliberately outside AppShell: there is no tenant, no navigation and nothing to
  // select until someone is signed in.
  return <div className="min-h-screen bg-surface-sunken">{children}</div>;
}
