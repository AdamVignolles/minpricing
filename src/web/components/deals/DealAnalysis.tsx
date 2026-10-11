import {
  Alert,
  Anchor,
  Badge,
  Group,
  Paper,
  Progress,
  RingProgress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import type { FC } from "react";

import type {
  CriterionStatus,
  Deal,
  DealAnalysis as Analysis,
  DealVerdict,
} from "../../types.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";

export interface DealAnalysisProps {
  deal: Deal;
  analysis: Analysis;
}

/**
 * Verdict wording and colour. Deliberately not the `signal` accent: the
 * score judges the whole offer (seller, reviews, data), not only its
 * price, and the accent stays reserved for price information. The verdict
 * is always spelled out, so colour is never the only carrier.
 */
const VERDICT: Record<DealVerdict, { label: string; color: string }> = {
  excellent: { label: "Excellent deal", color: "teal" },
  good: { label: "Bon deal", color: "teal" },
  fair: { label: "Deal correct", color: "yellow" },
  weak: { label: "Peu intéressant", color: "orange" },
};

const STATUS_COLOR: Record<CriterionStatus, string> = {
  good: "teal",
  neutral: "gray",
  bad: "orange",
  unknown: "gray.4",
};

const STATUS_LABEL: Record<CriterionStatus, string> = {
  good: "Bon",
  neutral: "Moyen",
  bad: "Faible",
  unknown: "Non vérifié",
};

const CONDITION_LABEL = {
  new: "Neuf",
  refurbished: "Reconditionné",
  used: "Occasion",
} as const;

const stars = (value: number) => `${value.toFixed(1).replace(".", ",")} / 5`;

/**
 * "Is this deal really worth it?", answered criterion by criterion: the
 * score out of 100, what each part of it is made of, and the raw facts
 * (seller, reviews, reference prices) behind each part — so the number
 * can always be checked rather than trusted.
 */
const DealAnalysis: FC<DealAnalysisProps> = ({ deal, analysis }) => {
  const verdict = VERDICT[analysis.verdict];

  const sellerRows: Array<[string, string]> = [];
  if (deal.sellerName) {
    sellerRows.push([
      "Vendeur",
      deal.soldByMerchant
        ? `${deal.sellerName} (vendu par la plateforme)`
        : `${deal.sellerName} (vendeur tiers)`,
    ]);
  }
  if (deal.sellerRating !== undefined) {
    sellerRows.push([
      "Note du vendeur",
      `${stars(deal.sellerRating)}${deal.sellerSalesCount ? ` · ${deal.sellerSalesCount.toLocaleString("fr-FR")} ventes` : ""}`,
    ]);
  }
  if (deal.shippedByMerchant !== undefined) {
    sellerRows.push([
      "Expédition",
      deal.shippedByMerchant ? "Par la plateforme" : "Par le vendeur",
    ]);
  }
  if (deal.offersCount) {
    sellerRows.push([
      "Offres sur ce site",
      `${deal.offersCount} offre${deal.offersCount > 1 ? "s" : ""}`,
    ]);
  }
  if (deal.productRating !== undefined && deal.productReviewCount) {
    sellerRows.push([
      "Avis produit",
      `${stars(deal.productRating)} · ${deal.productReviewCount.toLocaleString("fr-FR")} avis`,
    ]);
  }
  if (deal.recentPurchases) {
    sellerRows.push([
      "Popularité",
      `Plus de ${deal.recentPurchases.toLocaleString("fr-FR")} achats le mois dernier`,
    ]);
  }
  if (deal.condition) {
    sellerRows.push(["État", CONDITION_LABEL[deal.condition]]);
  }
  if (deal.ean) {
    sellerRows.push(["EAN", deal.ean]);
  }

  return (
    <Paper p="md" withBorder>
      <Stack gap="md">
        <Group gap="md" wrap="nowrap" align="center">
          <RingProgress
            size={92}
            thickness={8}
            roundCaps
            sections={[{ value: analysis.score, color: verdict.color }]}
            label={
              <Text ta="center" fw={700} fz="lg" lh={1} className="tnum">
                {analysis.score}
                <Text component="span" fz="xs" c="dimmed" fw={400}>
                  /100
                </Text>
              </Text>
            }
          />
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Title order={2} fz="lg">
              Analyse du deal
            </Title>
            <Group gap={6}>
              <Badge variant="light" color={verdict.color} size="lg">
                {verdict.label}
              </Badge>
              <Text fz="sm" c="dimmed" className="tnum">
                Note {analysis.score} / 100
              </Text>
            </Group>
          </Stack>
        </Group>

        {analysis.warnings.length > 0 ? (
          <Alert
            variant="light"
            color="orange"
            icon={<Icon name="alert" size={18} />}
            title="À vérifier avant d'acheter"
          >
            <Stack gap={4}>
              {analysis.warnings.map((warning) => (
                <Text key={warning} fz="sm">
                  {warning}
                </Text>
              ))}
            </Stack>
          </Alert>
        ) : null}

        <Stack gap="sm">
          {analysis.criteria.map((criterion) => (
            <Stack key={criterion.key} gap={4}>
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Group gap={6} wrap="nowrap">
                  <Text fz="sm" fw={600}>
                    {criterion.label}
                  </Text>
                  <Badge
                    size="xs"
                    variant="light"
                    color={STATUS_COLOR[criterion.status]}
                  >
                    {STATUS_LABEL[criterion.status]}
                  </Badge>
                </Group>
                <Text
                  fz="sm"
                  fw={600}
                  className="tnum"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {String(criterion.points).replace(".", ",")} / {criterion.max}
                </Text>
              </Group>
              <Progress
                value={(criterion.points / criterion.max) * 100}
                color={STATUS_COLOR[criterion.status]}
                size="sm"
                aria-label={`${criterion.label} : ${criterion.points} sur ${criterion.max}`}
              />
              <Text fz="xs" c="dimmed">
                {criterion.detail}
              </Text>
            </Stack>
          ))}
        </Stack>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <Stack gap={6}>
            <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
              Prix de référence
            </Text>
            {analysis.references.length === 0 && !analysis.bestAlternative ? (
              <Text fz="sm" c="dimmed">
                Aucune référence disponible pour l'instant.
              </Text>
            ) : (
              <Table fz="sm" withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  {analysis.references.map((ref) => (
                    <Table.Tr key={ref.kind}>
                      <Table.Td pl={0}>
                        {ref.label.charAt(0).toUpperCase() + ref.label.slice(1)}
                        <Text component="span" fz="xs" c="dimmed">
                          {ref.trust >= 0.8 ? " · fiable" : " · indicatif"}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right" className="tnum" pr={0}>
                        {f.price(ref.price, deal.currency)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {analysis.bestAlternative ? (
                    <Table.Tr>
                      <Table.Td pl={0}>
                        Meilleure alternative ({analysis.bestAlternative.label})
                      </Table.Td>
                      <Table.Td ta="right" className="tnum" pr={0}>
                        {f.price(analysis.bestAlternative.price, deal.currency)}
                      </Table.Td>
                    </Table.Tr>
                  ) : null}
                </Table.Tbody>
              </Table>
            )}
            {deal.marketPriceUrl ? (
              <Anchor
                href={deal.marketPriceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                fz="xs"
              >
                Voir le même produit chez{" "}
                {deal.marketPriceSource ?? "l'autre marchand"}
              </Anchor>
            ) : null}
          </Stack>

          <Stack gap={6}>
            <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
              Vendeur & produit
            </Text>
            {sellerRows.length === 0 ? (
              <Text fz="sm" c="dimmed">
                Informations vendeur pas encore relevées.
              </Text>
            ) : (
              <Table fz="sm" withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  {sellerRows.map(([label, value]) => (
                    <Table.Tr key={label}>
                      <Table.Td pl={0} c="dimmed">
                        {label}
                      </Table.Td>
                      <Table.Td ta="right" pr={0}>
                        {value}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        </SimpleGrid>
      </Stack>
    </Paper>
  );
};

export default DealAnalysis;
