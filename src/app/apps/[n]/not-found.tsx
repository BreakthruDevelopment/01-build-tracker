import Link from "next/link";
import { PageIntro } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";

export default function AppNotFound() {
  return (
    <PageIntro
      section="Portfolio"
      title="Unknown app"
      description="App numbers on this board run from 1 to 30."
      actions={
        <Link href="/" className={buttonSecondary}>
          Back to the board
        </Link>
      }
    />
  );
}
