export const metadata = {
  title: 'Zhongwenma | Smart Chinese Flashcards',
  description: 'Master Chinese, One Card at a Time',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
