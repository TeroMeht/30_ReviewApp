"use client";

import HeaderBox from "@/components/HeaderBox";
import Calendar from "@/components/execution/ExecutionCalendar";
import EmailFetcher from "@/components/execution/ExecutionEmailReader";

const ChartPage = () => {
  return (
    <section className="home">
      <div className="home-content">

        <header className="home-header">
          <HeaderBox
            type="greeting"
            title="Execution viewer"
            subtext="Monthly calendar"
          />
        </header>

<div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "24px 40px" }}>
  <Calendar />
  <EmailFetcher />
</div>
      </div>
    </section>
  );
};

export default ChartPage;
