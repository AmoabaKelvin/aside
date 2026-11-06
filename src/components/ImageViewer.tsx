import { AnimatePresence, motion } from 'motion/react'

const ease = [0.22, 1, 0.36, 1] as const

/** A click-to-enlarge view of one image, inside the card. Any click or Esc closes it. */
export function ImageViewer({ src, onClose }: { src: string | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {src && (
        <motion.div
          className="viewer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.18, ease }}
        >
          <motion.img
            src={src}
            alt=""
            draggable={false}
            initial={{ transform: 'scale(0.96)' }}
            animate={{ transform: 'scale(1)', transitionEnd: { transform: 'none' } }}
            exit={{ transform: ['scale(1)', 'scale(0.98)'], transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
