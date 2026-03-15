'use client';

import * as React from "react";
import Sidebar from "@/components/Sidebar";


export default function RootLayout({ children }: { children: React.ReactNode }) {

  return (
    <main className="flex h-screen w-full font-inter">
      {/* Sidebar with portfolio/control system data */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex-grow p-1">{children}</div>


    </main>
  );
}