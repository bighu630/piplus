"use client"

import { Tabs, TabsTrigger } from "./tabs"
import type { ReactNode } from "react"

type TabItem = {
  key: string
  label: string
  badge?: ReactNode | null
}

export function TabsBar({
  items,
  value,
  onChange,
}: {
  items: TabItem[]
  value: string
  onChange: (key: string) => void
}) {
  return (
    <Tabs value={value} onValueChange={onChange}>
      {items.map((item) => (
        <TabsTrigger key={item.key} value={item.key}>
          {item.label}
          {item.badge ? <span className="ml-1.5">{item.badge}</span> : null}
        </TabsTrigger>
      ))}
    </Tabs>
  )
}
