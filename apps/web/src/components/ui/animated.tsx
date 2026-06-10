"use client"

import { motion, type HTMLMotionProps, type Variants } from "framer-motion"
import type { ReactNode } from "react"

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
}

export const staggerChildren = {
  visible: {
    transition: {
      staggerChildren: 0.06,
    },
  },
}

type AnimatedContainerProps = HTMLMotionProps<"div"> & {
  children: ReactNode
  delay?: number
}

export function AnimatedContainer({ children, delay = 0, ...props }: AnimatedContainerProps) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={fadeInUp}
      transition={{ duration: 0.35, delay, ease: [0.22, 0.61, 0.36, 1] }}
      {...props}
    >
      {children}
    </motion.div>
  )
}

export function AnimatedList({ children, ...props }: HTMLMotionProps<"div"> & { children: ReactNode }) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerChildren}
      {...props}
    >
      {children}
    </motion.div>
  )
}

export function AnimatedItem({ children, ...props }: HTMLMotionProps<"div"> & { children: ReactNode }) {
  return (
    <motion.div variants={fadeInUp} transition={{ duration: 0.3, ease: [0.22, 0.61, 0.36, 1] }} {...props}>
      {children}
    </motion.div>
  )
}
