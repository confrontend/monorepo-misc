import unittest

from shared_pattern_discovery.stats import benjamini_hochberg, holm_bonferroni, mutual_information, pearson, spearman


class StatsTests(unittest.TestCase):
    def test_hand_computed_bh_and_holm_examples(self):
        bh = benjamini_hochberg([0.01, 0.04, 0.20])
        self.assertAlmostEqual(bh["q_values"][0], 0.03)
        self.assertAlmostEqual(bh["q_values"][1], 0.06)
        self.assertAlmostEqual(bh["q_values"][2], 0.20)
        holm = holm_bonferroni([0.01, 0.04, 0.20])
        self.assertEqual(holm["reject"], [True, False, False])

    def test_scanning_more_cells_makes_promotion_harder(self):
        one = benjamini_hochberg([0.001])["q_values"][0]
        many = benjamini_hochberg([0.001] + [0.01] * 99)["q_values"][0]
        self.assertGreater(many, one)

    def test_correlations_and_mutual_information(self):
        self.assertAlmostEqual(pearson([1, 2, 3], [2, 4, 6])["coefficient"], 1.0)
        self.assertAlmostEqual(spearman([1, 3, 2], [10, 30, 20])["coefficient"], 1.0)
        self.assertGreater(mutual_information([0, 0, 1, 1], [0, 0, 1, 1])["mutual_information"], 0.5)
